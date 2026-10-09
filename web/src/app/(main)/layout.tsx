import { cookies } from "next/headers";
import { AppProvider } from "@/components/AppProvider";
import { Gate } from "@/components/Gate";
import { JoinRequests } from "@/components/JoinRequests";
import { Shell } from "@/components/Shell";
import { DESKTOP_COOKIE, SESSION_COOKIE } from "@/lib/landing";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  // The desktop app is no visitor: signed out, it gets sign-in rather than the landing page.
  const visitor = !jar.has(SESSION_COOKIE) && !jar.has(DESKTOP_COOKIE);
  return (
    <AppProvider>
      <Gate visitor={visitor}>
        <Shell>
          <JoinRequests />
          {children}
        </Shell>
      </Gate>
    </AppProvider>
  );
}
