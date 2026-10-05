import { AppProvider } from "@/components/AppProvider";
import { Gate } from "@/components/Gate";
import { JoinRequests } from "@/components/JoinRequests";
import { Shell } from "@/components/Shell";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <Gate>
        <Shell>
          <JoinRequests />
          {children}
        </Shell>
      </Gate>
    </AppProvider>
  );
}
