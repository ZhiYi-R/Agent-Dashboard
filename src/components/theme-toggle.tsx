import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type Theme } from "@/components/theme-provider";
import { Monitor, Moon, Sun, Check } from "lucide-react";
import { useT } from "@/i18n";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const t = useT();

  const options: { value: Theme; label: string; icon: React.ElementType }[] = [
    { value: "light", label: t("theme.light"), icon: Sun },
    { value: "dark", label: t("theme.dark"), icon: Moon },
    { value: "system", label: t("theme.system"), icon: Monitor },
  ];

  const active = options.find((o) => o.value === theme) || options[2];
  const Icon = active.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Icon className="h-4 w-4" />
          <span className="sr-only">{t("theme.label")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            onClick={() => setTheme(o.value)}
            className={`flex items-center gap-2 pr-7 text-xs ${
              o.value === theme
                ? "bg-accent text-accent-foreground"
                : ""
            }`}
          >
            <o.icon className="h-3.5 w-3.5" />
            {o.label}
            <Check
              className={`absolute right-2 h-3.5 w-3.5 ${
                o.value === theme ? "opacity-100" : "opacity-0"
              }`}
              aria-hidden="true"
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
