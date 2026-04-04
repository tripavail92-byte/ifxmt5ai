import { LoginForm } from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; next?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  return <LoginForm initialMessage={resolvedSearchParams?.message} next={resolvedSearchParams?.next ?? "/"} />;
}
