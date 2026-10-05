import type { Metadata } from "next";
import { LegalPage } from "@/components/Legal";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return (
    <LegalPage title="Terms">
      <p>
        These terms cover the hosted service at starbridge.run and the Starbridge Android app. Last
        updated: 5 October 2026.
      </p>
      <p>
        Operator: Tom Vaucourt, an individual in France, running Starbridge as a non-professional.
        Contact: <a href="mailto:abuse@starbridge.run">abuse@starbridge.run</a>. Host: Hetzner
        Online GmbH, Industriestr. 25, 91710 Gunzenhausen, Germany.
      </p>

      <h2 className="t-heading">The service</h2>
      <p>
        Starbridge relays encrypted messages between your coding agents and your devices: quota
        windows, decisions and your answers. It is free to use, and what it does today stays free.
        Anything that costs money will be announced on this site at least 60 days before, and you
        are never charged without signing up for it. Each account can store a bounded amount, and
        the server deletes data on the schedule on the <a href="/privacy">privacy page</a>. The
        operator can change both.
      </p>

      <h2 className="t-heading">Your account</h2>
      <p>
        You sign in with GitHub. Your devices hold the only keys to your content, and the operator
        cannot recover it. If you lose every device and your recovery key, your content is gone.
      </p>

      <h2 className="t-heading">Fair use</h2>
      <p>
        Do not use Starbridge to break the law, to send anything to people who did not ask for it,
        to get around its limits, or to disrupt it for others. The operator may suspend an account
        that does. Write to <a href="mailto:abuse@starbridge.run">abuse@starbridge.run</a> to learn
        why and to appeal, within 30 days; you get an answer within 14 days.
      </p>

      <h2 className="t-heading">No guarantee</h2>
      <p>
        The service is provided as it is. It may be down, lose data, change or stop. Do not rely on
        it for anything where a missed or late message causes harm: an agent waiting on a decision
        should have a safe default. As far as the law allows, the operator is not liable for
        indirect losses or for lost data. Nothing here limits liability for gross negligence or
        intent, or the rights consumers have by law.
      </p>

      <h2 className="t-heading">Ending</h2>
      <p>
        You can stop using Starbridge at any time and ask for your account to be deleted, as the{" "}
        <a href="/privacy">privacy page</a> describes. If the operator shuts the service down, it
        will give notice on this site at least 30 days before.
      </p>

      <h2 className="t-heading">Law</h2>
      <p>
        French law applies, and French courts decide disputes. If you are a consumer, you keep the
        protection of your own country&apos;s law and courts.
      </p>

      <h2 className="t-heading">Changes</h2>
      <p>Changes to these terms are posted here with a new date.</p>
    </LegalPage>
  );
}
