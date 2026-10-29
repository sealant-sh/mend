import { useRouter } from "expo-router";
import { useEffect } from "react";

import { wireNotificationNavigation } from "@/data/notification-navigation";

export function NotificationRouting() {
  const router = useRouter();
  useEffect(
    () =>
      wireNotificationNavigation({
        push: (sessionId) => router.push({ pathname: "/session/[id]", params: { id: sessionId } }),
      }),
    [router],
  );
  return null;
}
