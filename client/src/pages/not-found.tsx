import { AlertCircle, ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { AppHeader } from "@/components/AppHeader";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <AppHeader active="dashboard" />
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <section
          className="w-full max-w-md rounded-md border border-border bg-muted/20 px-4 py-5"
          data-testid="not-found-panel"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-label font-medium uppercase tracking-wider text-muted-foreground">
                Not found
              </div>
              <h1 className="mt-1 text-title font-semibold tracking-tight text-foreground">
                Page not found
              </h1>
              <p className="mt-2 text-body leading-5 text-muted-foreground">
                This route is not available in PatchDeck.
              </p>
            </div>
          </div>

          <Link
            href="/"
            className="mt-4 inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-label font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Dashboard
          </Link>
        </section>
      </main>
    </div>
  );
}
