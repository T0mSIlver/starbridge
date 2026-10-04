import { AppProvider } from "@/components/AppProvider";
import { Gate } from "@/components/Gate";
import { Shell } from "@/components/Shell";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <Gate>
        <Shell>{children}</Shell>
      </Gate>
    </AppProvider>
  );
}
