import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuperIndividual } from "./pages/SuperIndividual";
import { ThemeProvider } from "./context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { getOrCreatePaperclipReactRoot } from "./lib/react-root";
import "./index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 3000, refetchOnWindowFocus: true, retry: 1 } } });
const root = document.getElementById("root");
if (!root) throw new Error("super individual root element is missing");
getOrCreatePaperclipReactRoot(window, root).render(<StrictMode><AppErrorBoundary><QueryClientProvider client={queryClient}><ThemeProvider><TooltipProvider><SuperIndividual /></TooltipProvider></ThemeProvider></QueryClientProvider></AppErrorBoundary></StrictMode>);
