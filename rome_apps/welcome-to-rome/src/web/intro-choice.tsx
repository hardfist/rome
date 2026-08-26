import { createRoot } from "react-dom/client";
import { MessagesSquare, Sparkles } from "lucide-react";
import { defineComponent, type AppComponentContext } from "@rome-os/app-web-sdk";
import { ChoiceCard, type Choice } from "@/lib/cards";
import { getWelcomeCopy } from "@/lib/copy";

// The opening "how should we do this?" card. Submits `{ choice: "import" | "answer" }`.
function IntroChoice({ ctx }: { ctx: AppComponentContext }) {
  const copy = getWelcomeCopy(ctx.bootstrap.shell.locale);
  const choices: Choice[] = [
    {
      value: "import",
      title: copy.introChoice.importTitle,
      desc: copy.introChoice.importDescription,
      icon: <Sparkles className="size-4" />,
    },
    {
      value: "answer",
      title: copy.introChoice.answerTitle,
      desc: copy.introChoice.answerDescription,
      icon: <MessagesSquare className="size-4" />,
    },
  ];

  return (
    <div className="w-full max-w-lg">
      <ChoiceCard ctx={ctx} choices={choices} outputKey="choice" columns={2} />
    </div>
  );
}

defineComponent("intro-choice", (container, ctx) => {
  const root = createRoot(container);
  root.render(<IntroChoice ctx={ctx} />);
  return () => root.unmount();
});
