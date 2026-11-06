/**
 * Ticket data is untrusted. A reference is only rendered as a link when it parses as an https URL on github.com;
 * anything else (javascript:, other hosts, look-alike hosts, credentials in the URL) stays plain text.
 */
export function safeGithubUrl(ref: string | null | undefined): string | null {
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password || u.port) return null;
    return u.href;
  } catch {
    return null;
  }
}
