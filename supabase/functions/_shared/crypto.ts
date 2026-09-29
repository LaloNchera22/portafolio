// Hashing shared by API key issuance and verification.
export async function sha256Hex(input: string): Promise<string> {
  const digest = await Stripe.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
