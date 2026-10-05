import type { Metadata } from "next";
import { LegalPage, Todo } from "@/components/Legal";

export const metadata: Metadata = { title: "Privacy" };

// Every claim here follows the code: server/src/db.ts for what is stored, server/src/limits.ts
// for retention, deploy/ for logs and backups. Change this page when they change.
export default function Privacy() {
  return (
    <LegalPage title="Privacy">
      <p>
        This covers the hosted service at starbridge.run and the Starbridge Android app. A server
        you host yourself keeps its data on your own machine. Last updated:{" "}
        <Todo>publication date</Todo>.
      </p>
      <p>
        Operator: <Todo>legal name and address of the operator</Todo>. Contact:{" "}
        <a href="mailto:abuse@starbridge.run">abuse@starbridge.run</a>.
      </p>

      <h2 className="t-heading">What the server stores</h2>
      <ul>
        <li>
          Your GitHub account&apos;s numeric id, which identifies you at sign-in. The server does
          not store your login, name or email. Sign-in asks GitHub for no permissions; the server
          uses GitHub&apos;s token once to read the id, then drops it.
        </li>
        <li>
          The public keys of your devices and machines, and the names you give them, in a list they
          sign.
        </li>
        <li>Hashes of your sign-in sessions, which expire after a year, and of machine tokens.</li>
        <li>
          For each device that gets notifications: the push service, its token or endpoint URL, and
          the keys that encrypt pushes to it.
        </li>
        <li>
          Your decisions, answers, quota snapshots, permission prompts and runs. Your devices and
          machines encrypt them before upload, and the server cannot read them. It does see the kind
          of each one, its id, who sent it to whom, its size and when it arrived or was answered.
        </li>
      </ul>
      <p>The server deletes them on this schedule:</p>
      <ul>
        <li>answered decisions and their answers, 7 days after the answer;</li>
        <li>permission prompts, their answers and settled notices, 7 days after they arrive;</li>
        <li>runs, 1 day after their last update;</li>
        <li>unanswered decisions and quota snapshots, 30 days after they arrive;</li>
        <li>a request to pair a new device or machine, 10 minutes after it is made.</li>
      </ul>
      <p>
        Your account, device list and push targets stay until you delete them (see Deletion). A
        nightly copy of the database is kept on the server for 14 days, and Hetzner keeps its own
        backups of the server, so deleted data can remain in backups for up to 14 days.
      </p>

      <h2 className="t-heading">Logs</h2>
      <p>
        The web server (Caddy) keeps no access log. The server, Caddy and the web page log startup,
        errors and failed pushes; these lines can include an account id or a push endpoint, but not
        IP addresses or your content. Each log rotates at 50 MB, so how long it covers depends on
        traffic. <Todo>a fixed maximum age for logs, if one is wanted</Todo>. To enforce rate
        limits, the server counts requests per IP address in memory; it never writes them to disk,
        and a restart clears them.
      </p>

      <h2 className="t-heading">Who else sees what</h2>
      <ul>
        <li>
          <strong>GitHub</strong>, when you sign in: that your GitHub account uses Starbridge.
        </li>
        <li>
          <strong>Google Firebase Cloud Messaging</strong>, for the Android app: your phone&apos;s
          push token and each push, which holds the item&apos;s kind and ids and either its
          encrypted content or nothing more. Google cannot read the encrypted content.
        </li>
        <li>
          <strong>Your browser&apos;s push service</strong> (Google for Chrome, Mozilla for Firefox,
          Apple for Safari), when you turn on notifications on the web: the endpoint and pushes
          encrypted for your browser alone. It sees their size and timing.
        </li>
        <li>
          <strong>Your UnifiedPush distributor</strong>, if you use one instead of Firebase, sees
          the same as Firebase would.
        </li>
        <li>
          <strong>Hetzner</strong> hosts the server in Helsinki, Finland, and stores its backups.
        </li>
      </ul>
      <p>
        Self-hosted servers without their own push credentials send pushes through starbridge.run,
        which passes them to these services. Those pushes carry only encrypted content or ids. There
        are no ads, analytics or trackers in the app, the web page or the server.
      </p>

      <h2 className="t-heading">Deletion</h2>
      <p>
        Removing a device or machine from your account ends its sign-in and deletes its push
        targets; a push target the push service reports as gone is deleted too. To delete your whole
        account, email <a href="mailto:abuse@starbridge.run">abuse@starbridge.run</a> with your
        GitHub login.{" "}
        <Todo>
          how the operator confirms the request comes from the account&apos;s owner, and how soon it
          is done
        </Todo>
        . Backups age out within 14 days after that.
      </p>

      <h2 className="t-heading">Your rights</h2>
      <p>
        <Todo>
          the rights that apply (for example under the GDPR), the legal basis for processing, and
          the authority to complain to; these depend on the operator&apos;s jurisdiction
        </Todo>
        .
      </p>

      <h2 className="t-heading">Changes</h2>
      <p>Changes to this page are posted here with a new date.</p>
    </LegalPage>
  );
}
