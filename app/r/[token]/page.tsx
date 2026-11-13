import { notFound } from "next/navigation";
import Registration from "@/components/Registration";

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) notFound();
  const decoded = Buffer.from(token, "base64url");
  if (decoded.toString("base64url") !== token) notFound();
  return <Registration token={decoded.toString("hex")} />;
}
