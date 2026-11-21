import NightShift from "@/components/NightShift";

export const metadata = {
  title: "Night overview | Stagebook",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return <NightShift token={(await params).token} />;
}
