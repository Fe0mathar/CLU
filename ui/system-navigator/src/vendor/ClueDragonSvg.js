/** Canonical jade holographic dragon (reworked figure + head). Embedded for zero-fetch integration. */
export const CLUE_JADE_DRAGON_ANIMATED_SVG = String.raw`<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     viewBox="0 0 1024 1024"
     width="1024" height="1024"
     role="img"
     aria-labelledby="title description"
     data-component="CLU_E_PROJECT_DRAGON_ICON"
     data-state="idle"
     data-motion="on"
     style="--scan-ratio:0;--recognition-ratio:0;--selected-node:1">
  <title id="title">CLU-E Project — Jade Holographic Dragon</title>
  <desc id="description">A flying Japanese-style jade dragon coils around a sealed holographic truth pearl and four project quadrant nodes.</desc>

  <defs>
    <linearGradient id="jadeMain" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#032C23"/>
      <stop offset="0.19" stop-color="#00A86B"/>
      <stop offset="0.42" stop-color="#8FFFE0"/>
      <stop offset="0.57" stop-color="#22D9A0"/>
      <stop offset="0.78" stop-color="#00A86B"/>
      <stop offset="1" stop-color="#023D32"/>
    </linearGradient>

    <linearGradient id="jadeEdge" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#003C2D"/>
      <stop offset="0.35" stop-color="#00A86B"/>
      <stop offset="0.52" stop-color="#D7FFF4"/>
      <stop offset="0.72" stop-color="#00EAFF"/>
      <stop offset="1" stop-color="#006D55"/>
    </linearGradient>

    <linearGradient id="holoSweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#00EAFF" stop-opacity="0"/>
      <stop offset="0.36" stop-color="#00EAFF" stop-opacity="0.08"/>
      <stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.88"/>
      <stop offset="0.62" stop-color="#96FFE7" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#00A86B" stop-opacity="0"/>
    </linearGradient>

    <radialGradient id="pearlFill" cx="42%" cy="35%" r="65%">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="1"/>
      <stop offset="0.18" stop-color="#CBFFF4" stop-opacity="0.98"/>
      <stop offset="0.48" stop-color="#00EAFF" stop-opacity="0.62"/>
      <stop offset="0.72" stop-color="#00A86B" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#02060C" stop-opacity="0.18"/>
    </radialGradient>

    <radialGradient id="eyeFill" cx="35%" cy="30%" r="75%">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.32" stop-color="#F4AF2D"/>
      <stop offset="0.58" stop-color="#00EAFF"/>
      <stop offset="1" stop-color="#00422F"/>
    </radialGradient>

    <pattern id="scalePattern" width="58" height="42" patternUnits="userSpaceOnUse" patternTransform="rotate(9)">
      <path d="M0 21 Q14 2 29 21 Q44 40 58 21" fill="none" stroke="#D8FFF5" stroke-width="4" stroke-opacity="0.34"/>
      <path d="M-29 42 Q-15 23 0 42 Q14 61 29 42" fill="none" stroke="#008E67" stroke-width="3" stroke-opacity="0.38"/>
    </pattern>

    <filter id="jadeGlow" x="-80%" y="-80%" width="260%" height="260%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="11" result="blur"/>
      <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.00  0 0 0 0 0.82  0 0 0 0 0.55  0 0 0 0.72 0" result="jadeBlur"/>
      <feMerge>
        <feMergeNode in="jadeBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <filter id="softGlow" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="18" result="blur"/>
      <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.00 0 0 0 0 0.92 0 0 0 0 1.00 0 0 0 0.78 0" result="cyanBlur"/>
      <feMerge><feMergeNode in="cyanBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>

    <filter id="faultGlow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="8" result="r"/>
      <feColorMatrix in="r" type="matrix" values="0 0 0 0 0.90 0 0 0 0 0.10 0 0 0 0 0.04 0 0 0 0.85 0" result="rr"/>
      <feMerge><feMergeNode in="rr"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>

    <filter id="holoDistort" x="-30%" y="-30%" width="160%" height="160%">
      <feTurbulence type="fractalNoise" baseFrequency="0.006 0.025" numOctaves="2" seed="17" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.2" xChannelSelector="R" yChannelSelector="G"/>
    </filter>

    <path id="bodyPath" d="M278 274 C388 115 633 118 781 239 C903 339 869 507 706 555 C556 599 424 526 412 402 C402 297 507 254 612 308 C728 368 735 524 657 647 C590 752 669 869 886 842"/>

    <mask id="bodyMask" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
      <rect width="1024" height="1024" fill="black"/>
      <use href="#bodyPath" fill="none" stroke="white" stroke-width="72" stroke-linecap="round" stroke-linejoin="round"/>
    </mask>

    <mask id="dragonMask" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
      <rect width="1024" height="1024" fill="black"/>
      <use href="#bodyPath" fill="none" stroke="white" stroke-width="78" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M312 270 C284 202 215 166 151 187 C115 199 92 220 87 246 C80 272 104 291 139 284 C117 304 130 333 170 336 C210 339 235 317 250 299 C278 321 316 307 329 274 C337 253 329 234 312 218 Z" fill="white"/>
      <path d="M168 234 C126 217 78 226 52 250 C83 258 86 274 54 291 C96 305 143 295 176 270 Z" fill="white"/>
      <g fill="none" stroke="white" stroke-linecap="round" stroke-linejoin="round">
        <path d="M347 246 C355 183 321 141 287 116" stroke-width="28"/>
        <path d="M294 331 C257 385 211 397 166 374" stroke-width="30"/>
        <path d="M704 548 C757 526 805 542 838 579" stroke-width="31"/>
        <path d="M627 678 C594 726 548 751 498 744" stroke-width="30"/>
      </g>
      <path d="M875 842 C919 820 956 830 973 869 C943 859 920 876 918 910 C897 888 874 892 846 910 C853 880 839 856 818 839 C838 838 855 839 875 842 Z" fill="white"/>
    </mask>

    <clipPath id="dragonClip">
      <rect width="1024" height="1024" mask="url(#dragonMask)"/>
    </clipPath>
  </defs>

  <style>
    :root { color-scheme: dark; }
    .clue-root { transform-origin: 512px 512px; animation: rootFloat 8s ease-in-out infinite; }
    .ambient-halo { animation: haloBreath 4.2s ease-in-out infinite; }
    .orbit-slow { transform-origin: 536px 470px; animation: rotateCW 28s linear infinite; }
    .orbit-reverse { transform-origin: 536px 470px; animation: rotateCCW 19s linear infinite; }
    .recognition-sweep { transform-origin: 536px 470px; animation: rotateCW 8s cubic-bezier(.33,.05,.55,.96) infinite; }
    .body-flow { stroke-dasharray: 12 31 3 25; animation: dashFlow 5.2s linear infinite; }
    .body-glint { stroke-dasharray: 92 54 18 42; animation: dashFlow 8s linear infinite; }
    .holo-sweep { animation: sweepAcross 6.8s cubic-bezier(.4,0,.2,1) infinite; }
    .pearl { transform-origin: 536px 470px; animation: pearlPulse 3.7s ease-in-out infinite; }
    .pearl-seal { transform-origin: 536px 470px; animation: sealSpin 12s linear infinite; }
    .node { transform-box: fill-box; transform-origin: center; animation: nodeBreathe 4.4s ease-in-out infinite; }
    .node.n2 { animation-delay: -1.1s; }
    .node.n3 { animation-delay: -2.2s; }
    .node.n4 { animation-delay: -3.3s; }
    .whisker-a { transform-box: fill-box; transform-origin: 100% 50%; animation: whiskerA 5.5s ease-in-out infinite; }
    .whisker-b { transform-box: fill-box; transform-origin: 100% 20%; animation: whiskerB 6.2s ease-in-out infinite; }
    .mane-fringe { animation: maneShiver 3.9s ease-in-out infinite; transform-origin: 270px 230px; }
    .eye-flare { transform-origin: center; animation: eyePulse 2.8s ease-in-out infinite; }
    .spark { transform-box: fill-box; transform-origin: center; animation: sparkDrift 4.8s ease-in-out infinite; }
    .spark.s2 { animation-delay:-1.6s; }
    .spark.s3 { animation-delay:-3.1s; }
    .outer-progress, .inner-progress { opacity:0; transition:opacity .35s ease, stroke .35s ease; }
    .state-accent { opacity:0; transition:opacity .25s ease; }
    .fault-fracture { opacity:0; }
    .pause-notch { opacity:0; }
    .stale-arc { opacity:0; }
    .selected-halo { opacity:0; }

    [data-selected-quadrant="q1"] .node.n1,
    [data-selected-quadrant="q2"] .node.n2,
    [data-selected-quadrant="q3"] .node.n3,
    [data-selected-quadrant="q4"] .node.n4 {
      fill:#F4AF2D;
      stroke:#FFF0AE;
      filter:url(#softGlow);
    }

    [data-state="diagnosing"][data-selected-quadrant="q1"] .node.n1,
    [data-state="diagnosing"][data-selected-quadrant="q2"] .node.n2,
    [data-state="diagnosing"][data-selected-quadrant="q3"] .node.n3,
    [data-state="diagnosing"][data-selected-quadrant="q4"] .node.n4 { fill:#FF5500; stroke:#FFD1B3; }

    [data-state="patching_shadow"][data-selected-quadrant="q1"] .node.n1,
    [data-state="patching_shadow"][data-selected-quadrant="q2"] .node.n2,
    [data-state="patching_shadow"][data-selected-quadrant="q3"] .node.n3,
    [data-state="patching_shadow"][data-selected-quadrant="q4"] .node.n4 { fill:#39FF88; stroke:#D8FFE6; }

    [data-state="unknown"] .clue-root { opacity:.5; animation:unknownBreath 4s ease-in-out infinite; }
    [data-state="unknown"] .outer-containment { stroke-dasharray:40 25; }
    [data-state="unknown"] .recognition-sweep,
    [data-state="unknown"] .body-flow { animation:none; opacity:.25; }

    [data-state="scanning"] .outer-progress { opacity:1; stroke:#00EAFF; }
    [data-state="scanning"] .recognition-sweep { animation-duration:2.7s; }
    [data-state="scanning"] .holo-sweep { animation-duration:2.4s; }
    [data-state="scanning"] .node { animation-duration:1.6s; }

    [data-state="recognizing"] .inner-progress { opacity:1; stroke:#FF5500; }
    [data-state="recognizing"] .body-flow { stroke:#FF7A29; animation-duration:2.2s; opacity:.92; }
    [data-state="recognizing"] .selected-halo { opacity:.78; stroke:#FF5500; }

    [data-state="graph_committing"] .outer-progress,
    [data-state="graph_committing"] .inner-progress { opacity:1; stroke:#F4AF2D; }
    [data-state="graph_committing"] .orbit-slow { animation-duration:5s; }
    [data-state="graph_committing"] .pearl-seal { stroke:#F4AF2D; filter:url(#softGlow); }

    [data-state="committed"] .pearl-seal { stroke:#F4AF2D; animation:commitSeal 5.8s ease-in-out infinite; }
    [data-state="committed"] .body-flow { opacity:.38; animation-duration:10s; }

    [data-state="focused"] .selected-halo { opacity:1; stroke:#F4AF2D; }
    [data-state="focused"] .node.n1 { filter:url(#softGlow); }

    [data-state="diagnosing"] .selected-halo { opacity:1; stroke:#FF5500; animation:diagnosticPing 1.2s ease-in-out infinite; }
    [data-state="diagnosing"] .node.n1 { fill:#FF5500; }
    [data-state="diagnosing"] .body-flow { stroke:#FF5500; animation-duration:1.7s; }

    [data-state="patching_shadow"] .selected-halo { opacity:1; stroke:#39FF88; stroke-dasharray:14 9; animation:rotateCW 2.5s linear infinite; transform-origin:536px 470px; }
    [data-state="patching_shadow"] .body-flow { stroke:#39FF88; opacity:.82; }

    [data-state="stale"] .stale-arc { opacity:1; animation:staleOffset 3.5s ease-in-out infinite; }
    [data-state="stale"] .orbit-slow,
    [data-state="stale"] .orbit-reverse { animation-duration:48s; }
    [data-state="stale"] .outer-containment { opacity:.32; }

    [data-state="degraded"] .state-accent { opacity:.82; stroke:#FF5500; }
    [data-state="degraded"] .recognition-sweep { stroke-dasharray:26 35; animation-duration:13s; }

    [data-state="fault"] .fault-fracture { opacity:1; animation:faultFlash 1.8s steps(2,end) infinite; }
    [data-state="fault"] .clue-root * { animation-play-state:paused !important; }
    [data-state="fault"] .dragon-material { opacity:.56; }
    [data-state="fault"] .eye-flare { fill:#E64519; filter:url(#faultGlow); }

    [data-state="paused"] .clue-root * { animation-play-state:paused !important; }
    [data-state="paused"] .pause-notch { opacity:1; }

    [data-motion="off"] .clue-root *,
    [data-motion="off"] .clue-root { animation:none !important; }

    @media (prefers-reduced-motion: reduce) {
      .clue-root *, .clue-root { animation:none !important; }
      .recognition-sweep { opacity:.35; }
    }

    @keyframes rootFloat { 0%,100%{transform:translateY(0) rotate(-.4deg)} 50%{transform:translateY(-8px) rotate(.55deg)} }
    @keyframes haloBreath { 0%,100%{opacity:.18;transform:scale(.98)} 50%{opacity:.38;transform:scale(1.035)} }
    @keyframes rotateCW { to{transform:rotate(360deg)} }
    @keyframes rotateCCW { to{transform:rotate(-360deg)} }
    @keyframes dashFlow { to{stroke-dashoffset:-240} }
    @keyframes sweepAcross { 0%{transform:translateX(-900px) skewX(-8deg);opacity:0} 18%{opacity:.08} 47%{opacity:.92} 72%{opacity:.16} 100%{transform:translateX(1200px) skewX(-8deg);opacity:0} }
    @keyframes pearlPulse { 0%,100%{transform:scale(.96);opacity:.9} 50%{transform:scale(1.06);opacity:1} }
    @keyframes sealSpin { to{transform:rotate(360deg)} }
    @keyframes nodeBreathe { 0%,100%{transform:scale(.92);opacity:.72} 50%{transform:scale(1.12);opacity:1} }
    @keyframes whiskerA { 0%,100%{transform:rotate(-1deg) translateY(0)} 50%{transform:rotate(2.4deg) translateY(-3px)} }
    @keyframes whiskerB { 0%,100%{transform:rotate(1.3deg)} 50%{transform:rotate(-2.6deg) translateY(4px)} }
    @keyframes maneShiver { 0%,100%{transform:rotate(-.35deg)} 50%{transform:rotate(.7deg)} }
    @keyframes eyePulse { 0%,100%{transform:scale(.9);opacity:.75} 50%{transform:scale(1.22);opacity:1} }
    @keyframes sparkDrift { 0%,100%{transform:translate(0,5px) scale(.7);opacity:.25} 50%{transform:translate(8px,-9px) scale(1.15);opacity:.9} }
    @keyframes unknownBreath { 0%,100%{opacity:.35} 50%{opacity:.62} }
    @keyframes commitSeal { 0%,70%,100%{transform:scale(1);opacity:.7} 78%{transform:scale(1.12);opacity:1} 90%{transform:scale(1);opacity:.82} }
    @keyframes diagnosticPing { 0%{transform:scale(.86);opacity:.9} 100%{transform:scale(1.2);opacity:0} }
    @keyframes staleOffset { 0%,100%{transform:translate(0,0)} 50%{transform:translate(11px,-8px)} }
    @keyframes faultFlash { 0%,80%{opacity:.38} 81%,100%{opacity:1} }
  </style>

  <g class="clue-root">
    <!-- Holographic field / project boundary -->
    <g fill="none" transform="rotate(-14 536 470)">
      <ellipse class="ambient-halo" cx="536" cy="470" rx="418" ry="392" stroke="#00A86B" stroke-width="3" opacity=".23" filter="url(#jadeGlow)"/>
      <ellipse class="outer-containment" cx="536" cy="470" rx="405" ry="378" stroke="url(#jadeEdge)" stroke-width="5" stroke-dasharray="110 24 20 18" opacity=".58"/>
      <ellipse class="recognition-sweep" cx="536" cy="470" rx="388" ry="361" stroke="#00EAFF" stroke-width="8" stroke-linecap="round" stroke-dasharray="86 2320" opacity=".78" filter="url(#softGlow)"/>
      <ellipse class="stale-arc" cx="536" cy="470" rx="420" ry="390" stroke="#FF8A2B" stroke-width="8" stroke-dasharray="44 24" opacity="0"/>
      <ellipse class="outer-progress" cx="536" cy="470" rx="397" ry="370" stroke="#00EAFF" stroke-width="9" stroke-linecap="round" stroke-dasharray="2414" stroke-dashoffset="2414" opacity="0"/>
      <ellipse class="inner-progress" cx="536" cy="470" rx="371" ry="344" stroke="#FF5500" stroke-width="7" stroke-linecap="round" stroke-dasharray="2251" stroke-dashoffset="2251" opacity="0"/>
    </g>

    <!-- Central sealed truth pearl and four quadrant witnesses -->
    <g class="project-core">
      <circle cx="536" cy="470" r="126" fill="#02060C" fill-opacity=".42" stroke="#00A86B" stroke-width="2" opacity=".8"/>
      <g class="orbit-slow">
        <path d="M536 318 L552 334 L536 350 L520 334 Z" class="node n1" fill="#00A86B" stroke="#B8FFF0" stroke-width="3"/>
        <path d="M688 470 l-15 19 h-24 l-15-19 15-19 h24 z" class="node n2" fill="#00A86B" stroke="#B8FFF0" stroke-width="3"/>
        <path d="M536 590 l18 10 v20 l-18 10 -18-10 v-20 z" class="node n3" fill="#00A86B" stroke="#B8FFF0" stroke-width="3"/>
        <path d="M384 470 l18-18 18 18-18 18z" class="node n4" fill="#00A86B" stroke="#B8FFF0" stroke-width="3"/>
        <path d="M536 350 C610 350 656 396 656 470 C656 544 610 590 536 590 C462 590 416 544 416 470 C416 396 462 350 536 350" fill="none" stroke="#00EAFF" stroke-width="2.5" stroke-dasharray="12 18" opacity=".48"/>
      </g>
      <g class="orbit-reverse">
        <circle cx="536" cy="470" r="95" fill="none" stroke="#00A86B" stroke-width="4" stroke-dasharray="36 16 5 16" opacity=".52"/>
        <circle cx="536" cy="375" r="5" fill="#00EAFF" filter="url(#softGlow)"/>
        <circle cx="631" cy="470" r="4" fill="#D7FFF4"/>
        <circle cx="536" cy="565" r="5" fill="#00EAFF" filter="url(#softGlow)"/>
        <circle cx="441" cy="470" r="4" fill="#D7FFF4"/>
      </g>
      <circle class="selected-halo" cx="536" cy="470" r="143" fill="none" stroke="#F4AF2D" stroke-width="7" opacity="0"/>
      <g class="dragon-figure-rear" filter="url(#jadeGlow)"><path d="M 148.4,797.5 L 156.0,803.1 L 163.9,808.5 L 172.0,813.6 L 180.3,818.7 L 188.7,823.6 L 197.3,828.3 L 206.0,833.0 L 214.8,837.5 L 223.8,841.8 L 232.9,846.0 L 242.2,850.1 L 251.6,854.1 L 261.0,857.9 L 270.6,861.5 L 280.4,865.0 L 290.2,868.4 L 300.1,871.6 L 310.1,874.7 L 320.2,877.6 L 330.4,880.4 L 340.7,883.0 L 351.0,885.4 L 361.4,887.7 L 371.9,889.9 L 382.5,891.8 L 393.1,893.6 L 403.8,895.3 L 414.5,896.8 L 425.3,898.1 L 436.2,899.2 L 447.0,900.2 L 457.9,901.0 L 468.9,901.6 L 479.9,902.1 L 490.9,902.4 L 501.9,902.5 L 512.9,902.4 L 524.0,902.1 L 535.0,901.6 L 546.1,901.0 L 557.2,900.2 L 568.2,899.1 L 579.3,897.9 L 590.3,896.5 L 601.4,894.9 L 612.4,893.1 L 623.4,891.1 L 634.3,888.8 L 645.2,886.4 L 656.1,883.8 L 667.0,880.9 L 677.8,877.9 L 688.5,874.6 L 699.2,871.2 L 709.9,867.5 L 720.4,863.5 L 730.9,859.4 L 741.4,855.0 L 751.7,850.4 L 762.0,845.6 L 772.2,840.6 L 782.3,835.3 L 792.3,829.8 L 802.2,824.1 L 800.0,800.0 L 812.6,817.9 L 820.5,812.6 L 828.1,807.1 L 835.5,801.6 L 842.6,795.9 L 849.5,790.0 L 856.2,784.1 L 862.6,778.0 L 868.8,771.8 L 874.8,765.5 L 880.6,759.1 L 886.1,752.6 L 891.4,746.0 L 896.4,739.3 L 901.3,732.6 L 905.9,725.7 L 910.3,718.7 L 914.5,711.7 L 918.5,704.6 L 922.2,697.5 L 925.7,690.2 L 929.1,683.0 L 932.2,675.6 L 935.1,668.2 L 937.8,660.8 L 940.3,653.3 L 942.6,645.8 L 944.7,638.3 L 946.6,630.7 L 948.3,623.1 L 949.8,615.5 L 951.1,607.9 L 952.2,600.3 L 953.2,592.7 L 954.0,585.0 L 954.6,577.4 L 955.0,569.8 L 955.2,562.1 L 955.3,554.5 L 955.2,546.9 L 955.0,539.4 L 954.6,531.8 L 954.0,524.3 L 953.3,516.8 L 952.4,509.3 L 951.4,501.9 L 897.4,510.7 L 898.3,517.0 L 899.1,523.4 L 899.8,529.8 L 900.4,536.2 L 900.8,542.6 L 901.1,549.1 L 901.3,555.5 L 901.3,562.0 L 901.2,568.4 L 901.0,574.9 L 900.6,581.3 L 900.1,587.8 L 899.4,594.2 L 898.6,600.7 L 897.7,607.1 L 896.6,613.5 L 895.3,619.9 L 893.9,626.2 L 892.3,632.6 L 890.6,638.9 L 888.7,645.2 L 886.6,651.4 L 884.4,657.6 L 882.0,663.8 L 879.5,670.0 L 876.7,676.1 L 873.8,682.2 L 870.7,688.2 L 867.5,694.2 L 864.0,700.1 L 860.4,706.0 L 856.5,711.9 L 852.5,717.6 L 848.2,723.4 L 843.8,729.1 L 839.1,734.7 L 834.3,740.2 L 829.2,745.7 L 823.9,751.1 L 818.4,756.5 L 812.7,761.8 L 806.7,767.0 L 800.5,772.1 L 794.0,777.1 L 787.4,782.1 L 800.0,800.0 L 779.2,787.7 L 770.3,793.3 L 761.3,798.7 L 752.2,803.9 L 743.0,808.9 L 733.7,813.7 L 724.3,818.4 L 714.8,822.8 L 705.2,827.0 L 695.5,831.0 L 685.8,834.9 L 676.0,838.6 L 666.1,842.0 L 656.1,845.3 L 646.1,848.4 L 636.0,851.3 L 625.8,854.1 L 615.6,856.6 L 605.3,859.0 L 595.0,861.1 L 584.7,863.2 L 574.3,865.0 L 563.9,866.6 L 553.4,868.1 L 543.0,869.4 L 532.5,870.5 L 522.0,871.5 L 511.5,872.2 L 500.9,872.9 L 490.4,873.3 L 479.9,873.6 L 469.3,873.7 L 458.8,873.6 L 448.3,873.4 L 437.8,873.0 L 427.4,872.4 L 416.9,871.7 L 406.5,870.8 L 396.2,869.8 L 385.8,868.6 L 375.5,867.3 L 365.3,865.8 L 355.1,864.1 L 345.0,862.3 L 334.9,860.4 L 324.9,858.3 L 314.9,856.0 L 305.0,853.6 L 295.2,851.1 L 285.5,848.4 L 275.9,845.6 L 266.3,842.6 L 256.9,839.5 L 247.5,836.3 L 238.2,832.9 L 229.1,829.4 L 220.0,825.8 L 211.1,822.0 L 202.2,818.1 L 193.5,814.1 L 184.9,810.0 L 176.4,805.7 L 168.1,801.4 L 159.8,796.9 L 151.6,792.5 Z" fill="url(#jadeMain)" stroke="url(#jadeEdge)" stroke-width="3.5"/></g>
<g class="pearl" filter="url(#softGlow)">
        <circle cx="536" cy="470" r="63" fill="url(#pearlFill)" stroke="#D7FFF4" stroke-width="4"/>
        <ellipse cx="516" cy="445" rx="18" ry="11" fill="#FFFFFF" opacity=".72" transform="rotate(-26 516 445)"/>
        <circle cx="536" cy="470" r="48" fill="none" stroke="#00EAFF" stroke-width="2" stroke-dasharray="7 12" opacity=".8"/>
        <path d="M536 428 L547 459 L579 470 L547 481 L536 512 L525 481 L493 470 L525 459 Z" fill="#FFFFFF" fill-opacity=".22" stroke="#D7FFF4" stroke-width="2"/>
      </g>
<g class="dragon-figure" filter="url(#jadeGlow)">
  <path d="M 952.4,509.3 L 951.4,501.9 L 950.2,494.5 L 948.9,487.2 L 947.4,479.9 L 945.8,472.6 L 944.1,465.4 L 942.2,458.3 L 940.2,451.2 L 938.1,444.2 L 935.8,437.3 L 933.4,430.4 L 930.9,423.6 L 928.3,416.9 L 925.5,410.2 L 922.7,403.7 L 919.7,397.2 L 916.6,390.8 L 913.4,384.5 L 910.1,378.3 L 906.7,372.2 L 880.0,380.0 L 903.4,366.6 L 899.8,360.5 L 896.1,354.4 L 892.3,348.4 L 888.4,342.4 L 884.4,336.5 L 880.2,330.6 L 875.9,324.8 L 871.6,319.0 L 867.1,313.3 L 862.5,307.7 L 857.8,302.1 L 853.0,296.5 L 848.2,291.1 L 843.2,285.6 L 838.1,280.3 L 832.9,275.0 L 827.7,269.8 L 822.3,264.7 L 816.8,259.6 L 811.3,254.6 L 805.7,249.7 L 800.0,244.9 L 794.2,240.1 L 788.3,235.5 L 782.4,230.9 L 776.3,226.4 L 770.2,222.0 L 764.1,217.7 L 757.8,213.5 L 751.5,209.3 L 745.1,205.3 L 738.6,201.3 L 732.1,197.5 L 725.5,193.8 L 718.9,190.1 L 712.2,186.6 L 705.4,183.2 L 698.6,179.9 L 691.7,176.7 L 684.7,173.6 L 677.8,170.6 L 670.7,167.8 L 663.6,165.0 L 656.5,162.4 L 649.3,159.9 L 642.1,157.6 L 634.9,155.3 L 627.6,153.2 L 620.3,151.2 L 612.9,149.4 L 605.5,147.7 L 598.1,146.1 L 590.6,144.7 L 583.1,143.4 L 575.7,142.2 L 568.1,141.2 L 560.6,140.4 L 553.0,139.6 L 545.5,139.1 L 537.9,138.7 L 530.3,138.4 L 522.7,138.3 L 515.1,138.4 L 507.5,138.6 L 500.0,150.0 L 499.9,139.4 L 494.3,139.9 L 488.7,140.5 L 483.3,141.2 L 477.9,142.0 L 472.6,142.8 L 467.4,143.8 L 462.2,144.8 L 457.2,145.9 L 452.2,147.2 L 447.4,148.5 L 442.7,150.0 L 438.1,151.6 L 433.5,153.0 L 428.9,154.0 L 424.4,155.0 L 420.0,156.1 L 415.6,157.2 L 411.4,158.5 L 407.2,159.8 L 403.1,161.1 L 399.1,162.6 L 395.2,164.1 L 391.4,165.7 L 387.6,167.3 L 384.0,169.1 L 380.4,170.8 L 377.0,172.7 L 373.6,174.6 L 370.3,176.6 L 367.1,178.7 L 364.1,180.8 L 361.1,183.0 L 358.2,185.3 L 355.4,187.7 L 352.7,190.1 L 350.1,192.6 L 347.6,195.1 L 345.3,197.7 L 343.0,200.4 L 340.8,203.2 L 338.8,206.0 L 336.8,208.9 L 335.0,211.8 L 333.3,214.9 L 331.7,218.0 L 330.2,221.1 L 328.8,224.3 L 327.6,227.6 L 326.4,231.0 L 325.4,234.4 L 324.5,237.8 L 323.7,241.4 L 323.1,245.0 L 322.6,248.6 L 322.1,252.3 L 321.9,256.1 L 321.7,259.9 L 321.7,263.8 L 321.8,267.8 L 322.0,271.8 L 322.4,275.8 L 322.8,280.0 L 323.5,284.1 L 324.2,288.4 L 328.0,292.0 L 328.0,292.0 L 330.1,287.2 L 329.4,283.1 L 328.8,279.1 L 328.3,275.1 L 328.0,271.3 L 327.8,267.4 L 327.7,263.7 L 327.7,260.0 L 327.9,256.3 L 328.1,252.8 L 328.5,249.3 L 329.0,245.8 L 329.6,242.4 L 330.4,239.1 L 331.2,235.9 L 332.2,232.7 L 333.2,229.5 L 334.4,226.5 L 335.7,223.5 L 337.1,220.5 L 338.6,217.6 L 340.2,214.8 L 341.9,212.0 L 343.7,209.3 L 345.7,206.7 L 347.7,204.1 L 349.8,201.6 L 352.1,199.1 L 354.4,196.7 L 356.9,194.4 L 359.4,192.1 L 362.0,189.9 L 364.8,187.8 L 367.6,185.7 L 370.6,183.6 L 373.6,181.7 L 376.7,179.8 L 380.0,177.9 L 383.3,176.1 L 386.7,174.4 L 390.2,172.8 L 393.8,171.2 L 397.5,169.6 L 401.3,168.2 L 405.2,166.8 L 409.1,165.5 L 413.2,164.2 L 417.3,163.0 L 421.5,161.9 L 425.9,160.8 L 430.2,159.8 L 434.7,158.9 L 439.4,158.5 L 444.2,158.6 L 449.0,158.5 L 453.8,158.5 L 458.7,158.6 L 463.7,158.7 L 468.7,158.8 L 473.8,158.9 L 478.9,159.2 L 484.1,159.4 L 489.4,159.8 L 494.7,160.1 L 500.1,160.6 L 500.0,150.0 L 507.3,161.6 L 514.4,162.2 L 521.5,163.0 L 528.5,163.9 L 535.5,165.0 L 542.5,166.2 L 549.5,167.5 L 556.4,168.9 L 563.3,170.4 L 570.1,172.1 L 576.9,173.8 L 583.7,175.7 L 590.4,177.7 L 597.1,179.8 L 603.7,182.1 L 610.3,184.4 L 616.9,186.8 L 623.4,189.4 L 629.9,192.0 L 636.3,194.8 L 642.7,197.6 L 649.0,200.5 L 655.3,203.6 L 661.5,206.7 L 667.6,209.9 L 673.8,213.2 L 679.8,216.6 L 685.8,220.1 L 691.8,223.7 L 697.7,227.3 L 703.5,231.1 L 709.3,234.9 L 715.0,238.8 L 720.6,242.8 L 726.2,246.8 L 731.7,250.9 L 737.1,255.1 L 742.5,259.4 L 747.8,263.7 L 753.1,268.1 L 758.2,272.5 L 763.3,277.0 L 768.3,281.6 L 773.2,286.2 L 778.1,290.9 L 782.9,295.6 L 787.6,300.4 L 792.2,305.3 L 796.7,310.2 L 801.1,315.1 L 805.5,320.1 L 809.8,325.1 L 813.9,330.2 L 818.0,335.3 L 822.0,340.4 L 825.9,345.6 L 829.7,350.8 L 833.4,356.0 L 837.0,361.3 L 840.6,366.6 L 844.0,371.9 L 847.3,377.2 L 850.5,382.6 L 853.6,388.0 L 856.6,393.4 L 880.0,380.0 L 859.7,399.0 L 862.4,404.3 L 865.2,409.6 L 867.8,415.1 L 870.4,420.6 L 872.9,426.2 L 875.2,431.8 L 877.6,437.5 L 879.8,443.3 L 881.9,449.2 L 883.9,455.1 L 885.8,461.1 L 887.6,467.2 L 889.4,473.3 L 891.0,479.4 L 892.5,485.6 L 893.9,491.8 L 895.2,498.0 L 896.3,504.3 L 897.4,510.7 L 898.3,517.0 Z" fill="url(#jadeMain)" stroke="url(#jadeEdge)" stroke-width="4"/>
  <path d="M 232.9,846.0 Q 233.3,864.0 246.9,851.6 Z M 351.0,885.4 Q 354.3,905.4 365.7,888.2 Z M 479.9,902.1 Q 486.9,914.8 494.9,902.1 Z M 612.4,893.1 Q 625.8,923.5 627.1,890.0 Z M 741.4,855.0 Q 761.4,881.5 755.0,848.7 Z M 842.6,795.9 Q 864.7,810.3 853.9,786.0 Z M 910.3,718.7 Q 951.8,734.5 917.8,705.7 Z M 946.6,630.7 Q 988.0,632.4 949.7,616.1 Z M 955.0,539.4 Q 986.8,530.4 954.1,524.4 Z M 940.2,451.2 Q 984.4,430.5 935.8,436.9 Z M 906.7,372.2 Q 939.4,345.5 899.3,359.1 Z M 862.5,307.7 Q 882.2,282.8 853.1,296.0 Z M 800.0,244.9 Q 823.3,207.1 788.6,235.1 Z M 725.5,193.8 Q 736.2,161.9 712.6,186.1 Z M 642.1,157.6 Q 642.1,136.8 628.0,152.5 Z M 553.0,139.6 Q 549.8,110.1 538.2,137.7 Z M 477.9,142.0 Q 470.1,129.8 462.9,142.9 Z M 420.0,156.1 Q 414.0,160.8 405.5,160.0 Z M 373.6,174.6 Q 361.1,167.5 360.8,182.4 Z" fill="url(#jadeEdge)" opacity="0.95"/>
  <path d="M 294.8,852.6 L 293.0,858.9 M 364.9,867.7 L 363.6,875.6 M 437.7,875.3 L 437.1,884.8 M 511.6,875.0 L 512.1,885.8 M 585.2,866.2 L 587.2,878.2 M 657.1,848.5 L 661.0,861.3 M 725.8,821.7 L 732.0,834.9 M 800.0,800.0 L 800.0,800.0 M 826.8,754.1 L 838.4,766.0 M 860.1,714.3 L 874.5,724.2 M 883.6,671.8 L 900.3,679.1 M 898.5,627.3 L 916.7,631.7 M 905.4,581.7 L 924.6,583.0 M 905.2,535.8 L 924.8,534.2 M 898.7,490.7 L 918.0,486.4 M 886.5,447.5 L 905.1,440.7 M 869.5,407.4 L 886.9,398.3 M 851.3,374.6 L 867.6,364.3 M 825.7,337.5 L 840.2,325.7 M 795.4,302.1 L 808.1,289.3 M 760.9,269.2 L 771.8,255.8 M 722.8,239.4 L 731.6,225.9 M 681.5,213.3 L 688.3,200.1 M 637.5,191.6 L 642.2,179.1 M 591.1,174.9 L 593.9,163.5 M 542.8,163.7 L 543.8,154.0 M 500.1,158.7 L 500.0,151.1 M 463.6,157.4 L 463.0,152.4 M 430.1,159.3 L 429.6,157.2 M 401.1,167.7 L 400.3,165.7 M 376.4,179.3 L 375.3,177.5 M 356.5,194.0 L 355.0,192.5" stroke="#8FE9CC" stroke-width="2.2" fill="none" opacity="0.55"/>
  <path fill="url(#jadeMain)" stroke="url(#jadeEdge)" stroke-width="2.5"
        d="M 150,795 C 108,770 78,772 48,796 C 84,796 106,810 122,834 C 96,838 80,852 72,874 C 104,862 130,862 152,876 C 142,846 144,818 150,795 Z"/>
  
<g class="dragon-head">
  <!-- MANE: one continuous flame sweep behind the skull -->
  <path filter="url(#jadeGlow)" fill="url(#jadeMain)" stroke="url(#jadeEdge)" stroke-width="3"
    d="M 330,262 C 292,214 258,192 200,186 C 236,214 252,238 258,266
       C 218,252 182,254 148,272 C 190,282 218,298 236,322
       C 196,326 166,342 146,370 C 190,362 224,368 250,388
       C 224,406 210,428 208,456 C 240,432 272,420 302,420
       C 296,392 300,362 314,334 Z"/>
  <!-- ANTLER HORNS: filled tapered branches swept back -->
  <g filter="url(#jadeGlow)" fill="url(#jadeEdge)" stroke="#DFFFF2" stroke-width="1.6">
    <path d="M 356,254 C 388,196 436,152 508,124 C 466,168 436,214 422,262 C 404,250 382,248 356,254 Z"/>
    <path d="M 470,160 C 502,138 540,126 584,128 C 546,148 516,172 494,202 Z"/>
    <path d="M 334,246 C 348,190 380,146 432,116 C 404,160 386,204 380,248 C 366,242 350,242 334,246 Z"/>
  </g>
  <!-- SKULL: long snout, pronounced brow, open jaw -->
  <path filter="url(#jadeGlow)" fill="url(#jadeMain)" stroke="url(#jadeEdge)" stroke-width="5"
    d="M 318,272 C 352,250 392,248 424,266 C 452,282 474,306 494,338
       C 510,362 522,382 528,402 C 512,398 498,392 486,384
       C 492,398 494,412 490,426 C 470,418 452,406 438,392
       C 420,398 402,398 386,392 C 374,406 358,414 340,416
       C 344,400 344,386 340,372 C 318,368 300,358 288,342
       C 300,330 312,322 326,318 C 308,308 296,294 292,276 Z"/>
  <!-- LOWER JAW: open, with chin barbel -->
  <path filter="url(#jadeGlow)" fill="url(#jadeMain)" stroke="url(#jadeEdge)" stroke-width="4"
    d="M 386,394 C 406,426 432,452 466,470 C 448,482 428,486 408,482
       C 414,498 412,512 402,524 C 380,508 364,488 356,466
       C 340,458 330,446 326,430 C 344,428 360,420 372,408 Z"/>
  <path fill="url(#jadeMain)" stroke="url(#jadeEdge)" stroke-width="2.5" opacity=".92"
    d="M 402,506 C 404,548 394,584 368,612 C 380,576 382,544 376,516 Z"/>
  <path fill="#06231B" stroke="none" opacity="0.9"
    d="M 392,390 C 416,414 442,434 470,448 C 448,452 428,450 410,442 C 398,428 390,412 386,396 Z"/>
  <!-- TEETH -->
  <g fill="#F2FFF9" stroke="#9BE8CF" stroke-width="1.4">
    <path d="M 470,388 L 486,414 L 456,400 Z"/>
    <path d="M 502,404 L 512,430 L 486,414 Z"/>
    <path d="M 438,394 L 448,416 L 424,402 Z"/>
    <path d="M 408,484 L 402,508 L 390,486 Z"/>
    <path d="M 440,470 L 444,494 L 424,478 Z"/>
    <path d="M 464,458 L 474,480 L 450,468 Z"/>
  </g>
  <!-- SNOUT ridge, upturned nose, nostril -->
  <path fill="none" stroke="url(#jadeEdge)" stroke-width="3.4" d="M 430,282 C 462,304 486,332 502,366"/>
  <path fill="url(#jadeMain)" stroke="url(#jadeEdge)" stroke-width="4"
    d="M 494,338 C 516,354 532,372 540,392 C 552,384 560,372 562,358 C 556,376 552,390 542,402 C 534,412 522,416 508,414 C 502,404 496,394 492,384 Z"/>
  <circle cx="524" cy="392" r="5.5" fill="#0B2B22" stroke="#7BE3C4" stroke-width="1.8"/>
  <!-- FIERCE EYE: large angled almond, slit pupil, glow -->
  <g class="dragon-eye" filter="url(#softGlow)">
    <path d="M 338,300 C 362,282 392,278 416,292 C 396,314 364,320 338,310 Z"
          fill="url(#eyeFill)" stroke="#FFE9A6" stroke-width="2.6"/>
    <ellipse cx="376" cy="297" rx="5.6" ry="12" fill="#081512" transform="rotate(-20 376 297)"/>
    <circle cx="371" cy="290" r="2.6" fill="#FFF7DA"/>
  </g>
  <!-- EAR fin -->
  <path fill="url(#jadeMain)" stroke="url(#jadeEdge)" stroke-width="2.5"
    d="M 322,262 C 300,236 292,208 300,178 C 314,204 330,224 350,238 C 338,244 328,252 322,262 Z"/>
  <!-- CHEEK frill spikes -->
  <g fill="url(#jadeEdge)" stroke="#DFFFF2" stroke-width="1.2">
    <path d="M 306,352 C 282,356 262,368 250,388 C 272,380 292,378 308,382 Z"/>
    <path d="M 316,376 C 296,386 282,402 276,424 C 294,410 312,404 328,404 Z"/>
  </g>
  <!-- BROW spike over the eye -->
  <path fill="url(#jadeEdge)" stroke="#DFFFF2" stroke-width="1.4"
    d="M 330,284 C 300,262 268,252 232,254 C 264,268 288,284 304,304 C 312,294 320,288 330,284 Z"/>
  <!-- WHISKERS: two long S-curls from the snout (kept clear of the pearl) -->
  <g fill="none" stroke="#BAF7E3" stroke-width="4" stroke-linecap="round" class="dragon-whisker" filter="url(#softGlow)">
    <path d="M 508,352 C 588,330 656,346 700,404 C 656,376 606,368 560,382"/>
    <path d="M 486,436 C 520,492 522,552 486,610 C 502,556 496,506 468,468"/>
  </g>
</g>
</g>
      <circle class="pearl-seal" cx="536" cy="470" r="77" fill="none" stroke="#00A86B" stroke-width="5" stroke-dasharray="17 10 4 10" opacity=".82"/>
      <path class="pause-notch" d="M518 438 v64 M554 438 v64" stroke="#F4AF2D" stroke-width="11" stroke-linecap="round" opacity="0"/>
    </g>

    <!-- Dragon outer glow -->
    

    <!-- Tail fin behind body -->
    <path class="dragon-material" d="M875 842 C919 820 956 830 973 869 C943 859 920 876 918 910 C897 888 874 892 846 910 C853 880 839 856 818 839 C838 838 855 839 875 842 Z" fill="url(#jadeMain)" stroke="#00EAFF" stroke-width="5" filter="url(#jadeGlow)"/>
    <path d="M859 851 C897 850 923 856 946 872 M854 874 C878 875 897 887 913 902" fill="none" stroke="#CFFFF1" stroke-width="4" opacity=".52"/>

    <!-- Main dragon body -->
    

    <!-- Dorsal spines -->
    

    <!-- Legs and claws -->
    

    <!-- Head mane, face, horns -->
    

    <!-- Whiskers and facial filaments -->
    

    <!-- Holographic material sweep constrained to dragon -->
    <g mask="url(#dragonMask)" opacity=".9" pointer-events="none">
      <rect class="holo-sweep" x="-900" y="0" width="380" height="1024" fill="url(#holoSweep)" transform="skewX(-8)"/>
      <g opacity=".16">
        <path d="M0 196 H1024 M0 244 H1024 M0 292 H1024 M0 340 H1024 M0 388 H1024 M0 436 H1024 M0 484 H1024 M0 532 H1024 M0 580 H1024 M0 628 H1024 M0 676 H1024 M0 724 H1024 M0 772 H1024 M0 820 H1024" stroke="#D7FFF4" stroke-width="2" stroke-dasharray="12 18"/>
      </g>
    </g>

    <!-- Holographic particles -->
    <g fill="#BFFFF0" filter="url(#softGlow)">
      <circle class="spark s1" cx="796" cy="168" r="5" opacity=".7"/>
      <circle class="spark s2" cx="907" cy="477" r="4" opacity=".55"/>
      <circle class="spark s3" cx="703" cy="891" r="5" opacity=".62"/>
      <circle class="spark s1" cx="229" cy="704" r="3.5" opacity=".55"/>
      <circle class="spark s2" cx="101" cy="500" r="4" opacity=".5"/>
      <path class="spark s3" d="M875 272 l6 14 14 6-14 6-6 14-6-14-14-6 14-6z" fill="#00EAFF" opacity=".64"/>
    </g>

    <!-- State fracture / degraded markers -->
    <g class="state-accent" fill="none" stroke="#FF5500" stroke-width="7" stroke-linecap="round" opacity="0">
      <path d="M791 202 l-18 26 22 17-28 30"/>
      <path d="M377 774 l19-25-21-20 27-28"/>
    </g>
    <g class="fault-fracture" fill="none" stroke="#E64519" stroke-width="10" stroke-linecap="round" filter="url(#faultGlow)" opacity="0">
      <path d="M509 388 l-32 45 37 31-46 58 42 31-30 55"/>
      <path d="M557 389 l31 46-34 32 45 54-40 35 29 55"/>
    </g>
  </g>
</svg>`;
