const keys = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
const privateKey = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d;
if (!privateKey) throw new Error("The generated private key could not be exported.");
const publicKey = btoa(String.fromCharCode(...publicKeyBytes))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/g, "");

// In Supabase Edge Function Secrets, paste this value into VAPID_PUBLIC_KEY.
// Paste the private key below into VAPID_PRIVATE_KEY; never share or commit it.
console.log(JSON.stringify({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey }, null, 2));
