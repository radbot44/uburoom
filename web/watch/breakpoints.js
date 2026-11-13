// @ts-check
/* The page's one phone breakpoint. web/watch-layout.js repeats it for the first paint (it runs before any
 * module); keep the two the same. Stylesheets read the result as body[data-layout='phone']. */
export const PHONE_LAYOUT = '(max-width: 700px), (pointer: coarse) and (max-height: 700px)';
