import Grid from "./components/home/Grid";
import Hero from "./components/home/Hero";
import { FloatingNav } from "./components/ui/FloatingNav ";
import { navItems } from "../data/navItems";

export default function Home() {
  return (
    <main className="relative bg-black-100 flex flex-col justify-center items-center overflow-hidden mx-auto min-h-screen ">
      <div className="w-full px-10">
        <FloatingNav navItems={navItems} />
        <Hero />
        <Grid />
      </div>
    </main>
  );
}
