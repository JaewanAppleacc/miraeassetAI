import type { Metadata } from "next";
import { DisclosureViewer } from "./viewer";

export const metadata: Metadata = {
  title: "DART Corpus Viewer",
  description: "제공 공시 코퍼스를 원본 변경 없이 탐색하고 열람하는 로컬 뷰어",
};

export default function Home() {
  return <DisclosureViewer />;
}
