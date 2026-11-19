import BookingRegistration from "@/components/BookingRegistration";
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  return <BookingRegistration token={(await params).token} />;
}
