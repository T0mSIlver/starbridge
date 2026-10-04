import { DecisionsProvider } from "@/components/DecisionsProvider";
import { Shell } from "@/components/Shell";
import { inbox } from "@/lib/fixtures/decisions";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <DecisionsProvider initial={inbox}>
      <Shell>{children}</Shell>
    </DecisionsProvider>
  );
}
