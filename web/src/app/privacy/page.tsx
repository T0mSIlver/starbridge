import type { Metadata } from "next";
import { LegalPage } from "@/components/Legal";

export const metadata: Metadata = { title: "Privacy" };

// Every claim here follows the code: server/src/db.ts for what is stored, server/src/limits.ts
// for retention, deploy/ for logs and backups. Change this page when they change.
export default function Privacy() {
  return (
    <LegalPage title="Privacy">
      <p>
        This covers the hosted service at starbridge.run and the Starbridge Android app. A server
        you host yourself keeps its data on your own machine. Last updated: 6 October 2026.
      </p>
      <p>
        Operator: Tom Vaucourt, an individual in France, running Starbridge as a non-professional.
        Contact: <a href="mailto:privacy@starbridge.run">privacy@starbridge.run</a>. Host: Hetzner
        Online GmbH, Industriestr. 25, 91710 Gunzenhausen, Germany, +49 9831 505-0.
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
        <li>
          Hashes of your sign-in sessions, which expire after a year, and of machine tokens. A new
          machine&apos;s token is also kept as is with its pairing request for about 10 minutes, so
          a reply lost on the way can be sent again; a backup taken in that time keeps it too.
        </li>
        <li>
          For each device that gets notifications: the push service, its token or endpoint URL, and
          the keys that encrypt pushes to it.
        </li>
        <li>
          Your decisions, answers, quota snapshots, permission prompts and their answers, runs, and
          the notices that close an item or say an agent is waiting. Your devices and machines
          encrypt them before upload, and the server cannot read them. It does see the kind of each
          one, its id, who sent it, which devices it went to, which item it answers or closes, its
          size, when it arrived, was updated or was answered, and whether an item asked for a
          notification.
        </li>
      </ul>
      <p>The server deletes them on this schedule:</p>
      <ul>
        <li>answered decisions and their answers, 7 days after the answer;</li>
        <li>permission prompts, their answers and settled notices, 7 days after they arrive;</li>
        <li>runs, 1 day after their last update;</li>
        <li>
          unanswered decisions and quota snapshots, 30 days after they arrive; a machine&apos;s new
          quota snapshot replaces its last one;
        </li>
        <li>a request to pair a new device or machine, 10 minutes after it is made.</li>
      </ul>
      <p>
        Your account, device list and push targets stay until you delete them (see Deletion). A
        nightly copy of the database is kept on the server for 14 days, and Hetzner keeps its own
        backups of the server, with those copies, for 7 more, so deleted data can remain in backups
        for up to 3 weeks.
      </p>

      <h2 className="t-heading">Logs</h2>
      <p>
        The web server (Caddy) keeps no access log. The server, Caddy and the web page log startup,
        errors and failed pushes; these lines can include an account id or a push endpoint, but not
        IP addresses or your content. Caddy&apos;s error log is the exception: for a request that
        failed at the proxy, it can hold the request&apos;s IP address, path and headers. Each keeps
        five files of 10 MB, so how long a log covers depends on traffic. To enforce rate limits,
        the server counts requests per IP address in memory; it never writes them to disk, and a
        restart clears them.
      </p>

      <h2 className="t-heading">Usage counts</h2>
      <p>
        To learn how Starbridge is used, the server counts what it already handles, per day. During
        the day it keeps one row per event; the rows that count active accounts, devices and
        machines hold their ids, so each counts once. When the day ends, the server keeps only the
        day&apos;s totals and deletes those rows. The totals hold no ids, and only the operator can
        read them, on the server. The daily totals are:
      </p>
      <ul>
        <li>
          accounts, devices and machines that used the server that day, with devices split into the
          web page and the Android app;
        </li>
        <li>accounts, devices and machines in total, and new accounts;</li>
        <li>
          items posted, by kind: decisions, answers, permission prompts, their answers, notices that
          a prompt or decision is over, quota snapshots, run updates and waiting states;
        </li>
        <li>
          answers by client (web page or Android app), and how long decisions and permission prompts
          waited for their answer, as the median and the 90th percentile;
        </li>
        <li>
          pushes by push service and outcome (sent, failed, gone, no route, dropped), and the same
          for pushes relayed for self-hosted servers;
        </li>
        <li>push targets by push service;</li>
        <li>which releases of the Android app, the web page and the CLI were in use.</li>
      </ul>

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
        are no ads, and no analytics beyond the usage counts above and the page analytics below.
      </p>

      <h2 className="t-heading">Page analytics</h2>
      <p>
        The landing page, the docs, this page and the terms count visits with Umami, which runs on
        the same server; the Android app does not. For each view Umami records the page, its title,
        the referring site, your browser, operating system, device type, screen size and language,
        and the country, region and city it looks up from your IP address. On the landing page,
        clicking a sign-in button, a docs link or a way to get the app, or copying an install
        command, records which one. The signed-in app counts no views. Only in a browser that just
        created an account does it record, once each, three steps: the first sign-in, the first
        machine paired and the first answer sent, with nothing about the account, its machines or
        its content; the app (not Umami) keeps a note of the steps left in that browser for two
        days. Since the server knows when each account was created, the operator could match that
        first sign-in to your account, and so to the visit Umami recorded. Umami sets no cookie,
        stores nothing in your browser and does not store your IP address: it tells visitors apart
        by a hash of the IP address, the browser and a salt that changes every day, so a visit
        cannot be traced back to you or linked to your visits on other days. A browser that sends Do
        Not Track is not counted. Umami keeps its records for 180 days at most, and the nightly
        backups keep them for up to 3 weeks more.
      </p>

      <h2 className="t-heading">Deletion</h2>
      <p>
        Removing a device or machine from your account ends its sign-in and deletes its push
        targets; a push target the push service reports as gone is deleted too. Its name and keys
        stay in your account&apos;s signed device list, which nothing rewrites, and the items
        encrypted for it stay until the schedule above deletes them. To delete your whole account,
        email <a href="mailto:privacy@starbridge.run">privacy@starbridge.run</a> with your GitHub
        login. To show the account is yours, you post a code the operator sends you in a public gist
        on that GitHub account. The operator deletes the account within 30 days of that, and backups
        age out within 3 weeks after.
      </p>

      <h2 className="t-heading">Your rights</h2>
      <p>
        The GDPR applies. The legal basis for storing your data is running the service you signed up
        for; logs and rate limits rest on the operator&apos;s legitimate interest in keeping it
        working and safe. You can ask to access, correct, delete or export your data, or object to
        its processing, at <a href="mailto:privacy@starbridge.run">privacy@starbridge.run</a>. Your
        content is encrypted, so only your devices can export it. You can complain to the CNIL
        (cnil.fr) or your own country&apos;s data protection authority.
      </p>

      <h2 className="t-heading">Changes</h2>
      <p>Changes to this page are posted here with a new date.</p>
    </LegalPage>
  );
}
