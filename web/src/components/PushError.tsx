import { SELF_HOST } from "@/lib/links";
import { PushNotConfigured } from "@/lib/push";

/**
 * Why turning on notifications failed. A server with no Web Push key and no relay says so in
 * words and links to what whoever runs it does (#2282); any other failure shows its message.
 */
export function PushError({ error }: { error: unknown }) {
  if (error instanceof PushNotConfigured)
    return (
      <>
        This server sends no browser notifications. Whoever runs it can{" "}
        <a href={`${SELF_HOST}#notifications`}>turn them on</a>.
      </>
    );
  return <>{error instanceof Error ? error.message : String(error)}</>;
}
