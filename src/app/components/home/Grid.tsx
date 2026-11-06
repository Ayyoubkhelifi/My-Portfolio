import React from "react";
import { BentoGrid, BentoGridItem } from "../ui/BentoGrid";
import { bentoGridItems } from "@/data/bentoGridItems";

const Grid = () => {
  return (
    <section id="about">
      <BentoGrid>
        {bentoGridItems.map((item, i) => (
          <BentoGridItem key={i} {...item} />
        ))}
      </BentoGrid>
    </section>
  );
};

export default Grid;
