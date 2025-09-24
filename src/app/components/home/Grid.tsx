import React from "react";
import { BentoGrid, BentoGridItem } from "../ui/BentoGrid";
import { bentoGridItems, BentoGridItemType } from "@/data/bentoGridItems";

const Grid = () => {
  return (
    // <section id="about">
    //   <div className="min-h-screen w-full flex items-center justify-center">
    //     {" "}
    //     <BentoGrid>
    //       {bentoGridItems.map((item: BentoGridItemType) => (
    //         <BentoGridItem key={item.id} {...item} />
    //       ))}
    //     </BentoGrid>
    //   </div>
    // </section>
    // );
    <section id="about">
      <BentoGrid className="w-full py-20">
        {bentoGridItems.map((item, i) => (
          <BentoGridItem key={i} {...item} />
        ))}
      </BentoGrid>
    </section>
  );
};

export default Grid;
