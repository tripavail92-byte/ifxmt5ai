import { LoginForm } from "./LoginForm";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { message?: string };
}) {
  return <LoginForm initialMessage={searchParams?.message} />;
}
