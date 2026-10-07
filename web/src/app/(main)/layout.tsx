import { cookies } from "next/headers";
import { AppProvider } from "@/components/AppProvider";
import { Gate } from "@/components/Gate";
import { JoinRequests } from "@/components/JoinRequests";
import { Shell } from "@/components/Shell";
import { SESSION_COOKIE } from "@/lib/landing";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const visitor = !(await cookies()).has(SESSION_COOKIE);
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
