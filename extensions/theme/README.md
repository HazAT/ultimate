The appearance of each browser: **System**, which follows the device and switches with it while the page is open, or an
explicit **Light** or **Dark** that never moves on its own. One visible palette command (`mod+k`) shows the current and
next preference, such as "Theme: System → Light", and cycles through System, Light, Dark and back to System.

The shell keeps the choice in `localStorage` (`ultimate.theme`) and applies it as the `dark` class on the page; the
script in `web/index.html` paints the next load from it before modules run, and `web/src/sdk/theme.ts` owns the
resolution. No choice is `System`, so a fresh browser follows its device; a `light` or `dark` stored before System
existed stays as it is.
