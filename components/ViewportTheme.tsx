"use client";

import { useEffect, useState } from "react";

export function ViewportTheme() {
  const [color, setColor] = useState("");

  useEffect(() => {
    setColor(getComputedStyle(document.documentElement).backgroundColor);
  }, []);

  return color ? <meta name="theme-color" content={color} /> : null;
}
