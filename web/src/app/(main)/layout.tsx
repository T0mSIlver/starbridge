import { DecisionsProvider } from "@/components/DecisionsProvider";
import { Shell } from "@/components/Shell";
import { decisions } from "@/lib/fixtures";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <DecisionsProvider initial={decisions}>
      <Shell>{children}</Shell>
    </DecisionsProvider>
  );
}
