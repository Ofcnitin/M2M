import { AuthForm } from "@/components/AuthForm";
import { safeNext } from "@/lib/url";
export const metadata = { title: "Sign in" };
export default function Login({ searchParams }: { searchParams: { next?: string } }) {
  const next = safeNext(searchParams.next);
  return <AuthForm next={next} />;
}
