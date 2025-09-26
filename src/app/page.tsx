import Grid from "./components/home/Grid";
import Hero from "./components/home/Hero";
import { FloatingNav } from "./components/ui/FloatingNav ";
import { navItems } from "../data/navItems";
import RecentProjects from "./components/home/RecentProjects";
import Clients from "./components/home/Clients";

export default function Home() {
  return (
    <main className="relative bg-black-100 flex flex-col justify-center items-center overflow-hidden mx-auto min-h-screen ">
      <div className="w-full px-10">
        <FloatingNav navItems={navItems} />
        <Hero />
        <Grid />
        <RecentProjects />
        <Clients />
      </div>
    </main>
  );
}
