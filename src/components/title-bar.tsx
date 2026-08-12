import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Minus, Square, X } from "lucide-react";
import { useT } from "@/i18n";

export function TitleBar() {
  const win = getCurrentWindow();
  const t = useT();

  return (
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 select-none items-center justify-between border-b bg-background pl-4 pr-2"
    >
      <div className="flex items-center gap-2" data-tauri-drag-region>
        <span className="text-sm font-semibold">{t("app.title")}</span>
        <span className="text-[10px] text-muted-foreground" data-tauri-drag-region>
          {t("app.subtitle")}
        </span>
      </div>

      <div className="flex items-center" data-tauri-drag-region>
        <ThemeToggle />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-none"
          onClick={() => win.minimize()}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-none"
          onClick={() => win.toggleMaximize()}
        >
          <Square className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-none hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => win.close()}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
