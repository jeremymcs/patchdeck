import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/dashboard";
import PRs from "@/pages/prs";
import Settings from "@/pages/settings";
import Releases from "@/pages/releases";
import Issues from "@/pages/issues";
import Logs from "@/pages/logs";
import NotFound from "@/pages/not-found";
import { WebLoginGate } from "@/components/WebLoginGate";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/prs" component={PRs} />
      <Route path="/settings" component={Settings} />
      <Route path="/releases" component={Releases} />
      <Route path="/issues" component={Issues} />
      <Route path="/logs" component={Logs} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <WebLoginGate>
            <Router hook={useHashLocation}>
              <AppRouter />
            </Router>
          </WebLoginGate>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
