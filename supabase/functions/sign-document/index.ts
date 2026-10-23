import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, degrees } from "npm:pdf-lib@1.17.1";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  try {
    const authorization = request.headers.get("Authorization") || "";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user }, error: authError } = await admin.auth.getUser(authorization.replace(/^Bearer /i, ""));
    if (authError || !user) return reply({ error: "Sign in before signing." }, 401);
    const raw = await request.text();
    if (raw.length > 2_000_000) return reply({ error: "Signature image is too large." }, 413);
    const { requestId, expectedPath, placement, signature } = JSON.parse(raw);
    if (!/^[0-9a-f-]{36}$/i.test(requestId) || typeof expectedPath !== "string" ||
        typeof signature !== "string" || !signature.startsWith("data:image/png;base64,") || !placement) {
      return reply({ error: "Invalid signing details." }, 400);
    }
    const { pageNumber, leftRatio: left, topRatio: top, widthRatio: width, heightRatio: height } = placement;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 ||
        ![left, top, width, height].every((v) => typeof v === "number" && Number.isFinite(v)) ||
        left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > 1.001 || top + height > 1.001) {
      return reply({ error: "Invalid signature placement." }, 400);
    }
    const { data: document, error: documentError } = await admin.from("signing_requests")
      .select("storage_path,status,active_signer_position").eq("id", requestId).single();
    if (documentError || !document || document.status !== "pending" || document.storage_path !== expectedPath) {
      return reply({ error: "The document changed. Reopen the request before signing." }, 409);
    }
    const { data: signer } = await admin.from("signing_request_signers").select("signer_id")
      .eq("request_id", requestId).eq("signer_id", user.id)
      .eq("signer_order", document.active_signer_position).eq("status", "pending").maybeSingle();
    if (!signer) return reply({ error: "It is not your turn to sign." }, 403);
    const bucket = admin.storage.from("signing-documents");
    const { data: source, error: downloadError } = await bucket.download(expectedPath);
    if (downloadError) throw downloadError;
    const pdf = await PDFDocument.load(await source!.arrayBuffer());
    if (pageNumber > pdf.getPageCount()) return reply({ error: "Invalid page." }, 400);
    const page = pdf.getPage(pageNumber - 1);
    const crop = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const viewWidth = rotation % 180 ? crop.height : crop.width;
    const viewHeight = rotation % 180 ? crop.width : crop.height;
    const x = left * viewWidth, y = (top + height) * viewHeight;
    let origin: [number, number];
    if (rotation === 90) origin = [crop.x + y, crop.y + x];
    else if (rotation === 180) origin = [crop.x + crop.width - x, crop.y + y];
    else if (rotation === 270) origin = [crop.x + crop.width - y, crop.y + crop.height - x];
    else origin = [crop.x + x, crop.y + crop.height - y];
    const png = Uint8Array.from(atob(signature.split(",")[1]), (c) => c.charCodeAt(0));
    const image = await pdf.embedPng(png);
    page.drawImage(image, { x: origin[0], y: origin[1], width: width * viewWidth,
      height: height * viewHeight, rotate: degrees(rotation) });
    const path = `${requestId}/versions/${crypto.randomUUID()}.pdf`;
    const { error: uploadError } = await bucket.upload(path, await pdf.save(), { contentType: "application/pdf", upsert: false });
    if (uploadError) throw uploadError;
    const { data: status, error: commitError } = await admin.rpc("commit_signing_version", {
      p_request_id: requestId, p_signer_id: user.id, p_expected_path: expectedPath, p_version_path: path,
    });
    // Keep unreferenced immutable versions on uncertain network outcomes; never delete a possibly committed PDF.
    if (commitError) return reply({ error: "Submission could not be confirmed. Refresh the request before retrying." }, 409);
    return reply({ status, storagePath: path });
  } catch (error) {
    console.error("Signing failed:", error);
    return reply({ error: "The signature could not be submitted. Refresh the request before retrying." }, 500);
  }
});
