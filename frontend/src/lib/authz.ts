export function getAdminEmails(): string[] {
  const raw = process.env.IFX_ADMIN_EMAILS?.trim();
  if (!raw) return ["admin@ifxsystem.com"];
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmails().includes(email.trim().toLowerCase());
}
