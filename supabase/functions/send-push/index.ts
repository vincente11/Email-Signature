import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const siteUrl = "https://vincente11.github.io/Email-Signature/collaboration.html";
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SigningRequest = {
  id: string;
  owner_id: string;
  file_name: string;
  status: "pending" | "completed" | "cancelled" | "draft";
  active_signer_position: number;
};

type RequestSigner = {
  signer_id: string;
  signer_order: number;
};

type PushSubscriptionRow = {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders });
}

function getVapidDetails() {
  const subject = Deno.env.get("VAPID_CONTACT");
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!subject || !publicKey || !privateKey) {
    throw new Error("VAPID_CONTACT, VAPID_PUBLIC_KEY, and VAPID_PRIVATE_KEY must be configured.");
  }
  return { subject, publicKey, privateKey };
}

async function matchesSecret(received: string | null, expected: string): Promise<boolean> {
  if (!received) return false;
  const encoder = new TextEncoder();
  const receivedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(received)));
  const expectedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(expected)));
  let difference = 0;
  for (let index = 0; index < receivedDigest.length; index += 1) {
    difference |= receivedDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
}

function createAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase service credentials are unavailable to the push function.");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function createNotification(request: SigningRequest, reminder: boolean) {
  const fileName = request.file_name || "a document";
  if (reminder && request.status === "pending") {
    return { title: "Signing reminder", body: `A reminder to review ${fileName} was sent by its owner.` };
  }
  if (request.status === "completed") {
    return { title: "Sign-off complete", body: `All signers have approved ${fileName}.` };
  }
  if (request.status === "cancelled") {
    return { title: "Sign-off request cancelled", body: `The sign-off request for ${fileName} was cancelled.` };
  }
  return { title: "Your sign-off is ready", body: `Your approval is requested for ${fileName}.` };
}

async function sendRequestUpdates(requestId: string, reminder: boolean): Promise<{ sent: number; removed: number }> {
  const admin = createAdminClient();
  const { data: request, error: requestError } = await admin
    .from("signing_requests")
    .select("id, owner_id, file_name, status, active_signer_position")
    .eq("id", requestId)
    .maybeSingle<SigningRequest>();
  if (requestError) throw requestError;
  if (!request || request.status === "draft") return { sent: 0, removed: 0 };

  const { data: signers, error: signerError } = await admin
    .from("signing_request_signers")
    .select("signer_id, signer_order")
    .eq("request_id", requestId)
    .returns<RequestSigner[]>();
  if (signerError) throw signerError;

  const recipientIds = request.status === "pending"
    ? signers.filter((signer) => signer.signer_order === request.active_signer_position).map((signer) => signer.signer_id)
    : [...new Set([request.owner_id, ...signers.map((signer) => signer.signer_id)])];
  if (recipientIds.length === 0) return { sent: 0, removed: 0 };

  const { data: subscriptions, error: subscriptionError } = await admin
    .from("push_subscriptions")
    .select("endpoint, user_id, p256dh, auth")
    .in("user_id", recipientIds)
    .returns<PushSubscriptionRow[]>();
  if (subscriptionError) throw subscriptionError;
  if (!subscriptions?.length) return { sent: 0, removed: 0 };

  const vapidDetails = getVapidDetails();
  const notification = createNotification(request, reminder);
  let sent = 0;
  let removed = 0;

  const results = await Promise.allSettled(subscriptions.map(async (subscription) => {
    const endpoint = new URL(subscription.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "fcm.googleapis.com" ||
      !endpoint.pathname.startsWith("/fcm/send/")
    ) {
      throw new Error("Push subscription endpoint is not a supported Chrome push endpoint.");
    }

    await webpush.sendNotification({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    }, JSON.stringify({
      ...notification,
      url: siteUrl,
      tag: `efficient-sign-${requestId}`,
    }), {
      TTL: 86400,
      urgency: "high",
      vapidDetails,
    });
  }));

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") {
      sent += 1;
      continue;
    }
    const error = result.reason;
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      (error.statusCode === 404 || error.statusCode === 410)
    ) {
      const { error: deleteError } = await admin
        .from("push_subscriptions")
        .delete()
        .eq("endpoint", subscriptions[index].endpoint);
      if (deleteError) throw deleteError;
      removed += 1;
    } else {
      console.error("Push delivery failed:", error);
    }
  }

  return { sent, removed };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method === "GET") {
    try {
      const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
      if (!publicKey) throw new Error("VAPID_PUBLIC_KEY must be configured.");
      return jsonResponse({ publicKey });
    } catch (error) {
      console.error("Push configuration could not be loaded:", error);
      return jsonResponse({ error: "Push notifications are not configured on the server." }, 503);
    }
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const senderSecret = Deno.env.get("PUSH_SENDER_SECRET");
  if (!senderSecret || !(await matchesSecret(request.headers.get("x-push-secret"), senderSecret))) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  try {
    const payload = await request.json();
    const requestId = payload && typeof payload.request_id === "string" ? payload.request_id : "";
    if (!requestIdPattern.test(requestId)) {
      return jsonResponse({ error: "A valid signing request ID is required." }, 400);
    }
    if (payload.reminder !== undefined && typeof payload.reminder !== "boolean") {
      return jsonResponse({ error: "The reminder flag must be a boolean." }, 400);
    }

    const result = await sendRequestUpdates(requestId, payload.reminder === true);
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    console.error("Signing push dispatch failed:", error);
    return jsonResponse({ error: "Push notifications could not be sent." }, 500);
  }
});
