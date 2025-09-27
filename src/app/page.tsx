import Grid from "./components/home/Grid";
import Hero from "./components/home/Hero";
import { FloatingNav } from "./components/ui/FloatingNav ";
import { navItems } from "../data/navItems";
import RecentProjects from "./components/home/RecentProjects";
import Clients from "./components/home/Clients";
import Experience from "./components/home/Experience";
import Approach from "./components/home/Approach";
import Footer from "./components/home/Footer";

export default function Home() {
  return (
    <main className="relative bg-black-100 flex flex-col justify-center items-center overflow-hidden mx-auto min-h-screen ">
      <div className="w-full px-10">
        <FloatingNav navItems={navItems} />
        <Hero />
        <Grid />
        <RecentProjects />
        <Clients />
        <Experience />
        <Approach />
        <Footer />
      </div>
    </main>
  );
}
