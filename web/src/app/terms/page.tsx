import type { Metadata } from "next";
import { LegalPage, Todo } from "@/components/Legal";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return (
    <LegalPage title="Terms">
      <p>
        These terms cover the hosted service at starbridge.run and the Starbridge Android app. Last
        updated: <Todo>publication date</Todo>.
      </p>
      <p>
        Operator: <Todo>legal name and address of the operator</Todo>. Contact:{" "}
        <a href="mailto:abuse@starbridge.run">abuse@starbridge.run</a>.
      </p>

      <h2 className="t-heading">The service</h2>
      <p>
        Starbridge relays encrypted messages between your coding agents and your devices: quota
        windows, decisions and your answers. It is free to use.{" "}
        <Todo>whether it stays free, and notice before any price</Todo>. Each account can store a
        bounded amount, and the server deletes data on the schedule on the{" "}
        <a href="/privacy">privacy page</a>. The operator can change both.
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
        that does. <Todo>notice and appeal process</Todo>.
      </p>

      <h2 className="t-heading">No guarantee</h2>
      <p>
        The service is provided as it is. It may be down, lose data, change or stop. Do not rely on
        it for anything where a missed or late message causes harm: an agent waiting on a decision
        should have a safe default. <Todo>liability wording</Todo>.
      </p>

      <h2 className="t-heading">Ending</h2>
      <p>
        You can stop using Starbridge at any time and ask for your account to be deleted, as the{" "}
        <a href="/privacy">privacy page</a> describes. If the operator shuts the service down, it
        will give notice on this site. <Todo>how much notice</Todo>.
      </p>

      <h2 className="t-heading">Law</h2>
      <p>
        <Todo>governing law and courts</Todo>.
      </p>

      <h2 className="t-heading">Changes</h2>
      <p>Changes to these terms are posted here with a new date.</p>
    </LegalPage>
  );
}
