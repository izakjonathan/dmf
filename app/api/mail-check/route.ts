import { equals, hash, json, probeContractEmail } from "@/lib/server";
export const maxDuration = 40;
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (
    Date.now() > 1794421161947 ||
    !equals(
      hash(key),
      "7c4b18c56aaabda023f6baa9b3cc32130680a255775c1f83c873e012d8b1b52a",
    )
  )
    return json({}, 404);
  return json(await probeContractEmail());
}
