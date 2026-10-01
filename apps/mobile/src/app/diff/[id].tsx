import { useLocalSearchParams } from "expo-router";

import { DiffPane } from "@/components/diff-pane";

export default function DiffScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return id === undefined ? null : <DiffPane changeId={id} />;
}
