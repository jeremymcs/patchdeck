import type { BackgroundJobKind } from "@shared/schema";

export function getActivityTargetRoute(kind: BackgroundJobKind): string | null {
  switch (kind) {
    case "babysit_pr":
    case "answer_pr_question":
      return "/prs";
    case "evaluate_issue":
    case "verify_issue":
    case "work_issue":
      return "/issues";
    case "process_release_run":
      return "/releases";
    case "sync_watched_repos":
    case "heal_deployment":
    case "generate_social_changelog":
    default:
      return null;
  }
}
