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
import Deployments from "@/pages/deployments";
import Issues from "@/pages/issues";
import Logs from "@/pages/logs";
import NotFound from "@/pages/not-found";
import { WebLoginGate } from "@/components/WebLoginGate";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";

function DashboardRoute() {
  return (
    <PageErrorBoundary pageName="Dashboard">
      <Dashboard />
    </PageErrorBoundary>
  );
}

function PRsRoute() {
  return (
    <PageErrorBoundary pageName="Pull requests">
      <PRs />
    </PageErrorBoundary>
  );
}

function SettingsRoute() {
  return (
    <PageErrorBoundary pageName="Settings">
      <Settings />
    </PageErrorBoundary>
  );
}

function ReleasesRoute() {
  return (
    <PageErrorBoundary pageName="Releases">
      <Releases />
    </PageErrorBoundary>
  );
}

function DeploymentsRoute() {
  return (
    <PageErrorBoundary pageName="Deployments">
      <Deployments />
    </PageErrorBoundary>
  );
}

function IssuesRoute() {
  return (
    <PageErrorBoundary pageName="Issues">
      <Issues />
    </PageErrorBoundary>
  );
}

function LogsRoute() {
  return (
    <PageErrorBoundary pageName="Logs">
      <Logs />
    </PageErrorBoundary>
  );
}

function NotFoundRoute() {
  return (
    <PageErrorBoundary pageName="Not found">
      <NotFound />
    </PageErrorBoundary>
  );
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={DashboardRoute} />
      <Route path="/prs" component={PRsRoute} />
      <Route path="/settings" component={SettingsRoute} />
      <Route path="/releases" component={ReleasesRoute} />
      <Route path="/deployments" component={DeploymentsRoute} />
      <Route path="/issues" component={IssuesRoute} />
      <Route path="/logs" component={LogsRoute} />
      <Route component={NotFoundRoute} />
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
