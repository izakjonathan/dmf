import Registration from "@/components/Registration";
export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return <Registration token={(await params).token} />;
}
