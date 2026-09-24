/* ============================================================================
 * Runinback — Games help. One central "how to play" entry per game, keyed by
 * the module id. The driver (games.js) shows this in an overlay from the
 * "How to play" button, and once automatically the first time you open a game.
 *
 * Each entry:
 *   you  — which side/color/symbol you control (seat 0 is always you).
 *   how  — the moves, as short steps.
 *   win  — the single win condition, in one line.
 *   tip  — one optional pointer to play better.
 * ========================================================================== */
(function () {
  "use strict";
  if (!window.RIBGames) return;

  window.RIBGames.HELP = {
    /* ---- core six --------------------------------------------------------- */
    tictactoe: {
      you: "You play the green ✕. The bot plays the blue ◯.",
      how: ["Tap any empty square to place your mark.", "You and the bot take turns."],
      win: "Line up three of your marks in a row — across, down or diagonally.",
      tip: "Take the center square first; it belongs to the most lines."
    },
    connect4: {
      you: "You drop the green discs. The bot drops the yellow ones.",
      how: ["Tap a column to drop your disc; it falls to the lowest free slot.", "Turns alternate."],
      win: "Connect four of your discs in a line — vertical, horizontal or diagonal.",
      tip: "Watch both ends of any three-in-a-row: block the bot before it closes four."
    },
    reversi: {
      you: "You play the light discs. The bot plays the dark ones.",
      how: ["Play on a highlighted square so it traps a line of the bot's discs between two of yours.", "Every trapped disc flips to your color. If you have no move, your turn is skipped."],
      win: "When neither side can move, the player with more discs on the board wins.",
      tip: "Corners can never be flipped — grab them and avoid handing them over."
    },
    mancala: {
      you: "You own the bottom row of pits and the store on the right.",
      how: ["Tap one of your pits to pick up its seeds and sow them one by one to the right.", "Land the last seed in your store to take another turn."],
      win: "When one side empties, each player banks their remaining seeds. Most seeds in your store wins.",
      tip: "Landing your last seed in an empty pit of yours captures the seeds directly across from it."
    },
    checkers: {
      you: "You play the light pieces (they move up the board).",
      how: ["Tap a piece, then a highlighted square to move it diagonally.", "If a jump is available you must take it; chained jumps capture several pieces.", "Reach the far row to crown a king, which moves both ways."],
      win: "Capture all of the bot's pieces, or leave it with no legal move.",
      tip: "Keep your back row intact as long as you can to stop the bot from crowning kings."
    },
    eights: {
      you: "Your hand is at the bottom. Playable cards are lifted and highlighted.",
      how: ["Play a card that matches the color or the number of the top card.", "An 8 is wild: play it any time, then choose the next color.", "Nothing to play? Draw a card."],
      win: "Be the first to empty your hand.",
      tip: "Save your 8s for when you're stuck or to swing the color to your favor."
    },

    /* ---- extra pack ------------------------------------------------------- */
    gomoku: {
      you: "You play the light stones. The bot plays the red ones.",
      how: ["Tap any empty point to place a stone anywhere on the board.", "Turns alternate — stones never move once placed."],
      win: "Be the first to line up five of your stones in a row, in any direction.",
      tip: "An open row of four with both ends free is unstoppable — build toward it, and block the bot's."
    },
    dots: {
      you: "Your closed boxes turn green. The bot's turn red.",
      how: ["Tap a gap between two dots to draw one line.", "Draw the fourth side of a box to claim it and take another turn."],
      win: "Own more boxes than the bot when every line is drawn.",
      tip: "Avoid drawing the third side of a box — it hands the fourth (and the box) to the bot."
    },
    morris: {
      you: "You play the light pieces. The bot plays the red ones.",
      how: ["First place your nine pieces on the points, one per turn.", "Then slide a piece along a line to a neighboring empty point.", "Form a mill (three in a line) to remove one of the bot's pieces."],
      win: "Cut the bot down to two pieces, or leave it with no move.",
      tip: "A piece you can slide out and back rebuilds a mill every other turn."
    },
    nim: {
      you: "Both players share the same rows of objects.",
      how: ["Tap an object to take it and everything to its right in that row.", "You must take at least one; you may take a whole row."],
      win: "Force the bot to take the very last object — taking it yourself loses.",
      tip: "Late in the game, leave an odd number of single objects for the bot."
    },
    chomp: {
      you: "Both players eat from the same grid.",
      how: ["Tap a square to eat it and every square below and to the right of it.", "The top-left ☠ square is poison."],
      win: "Make the bot eat the ☠ square — whoever eats it loses.",
      tip: "Taking a big bite usually just leaves the bot a safe reply; small nibbles keep control."
    },
    orderchaos: {
      you: "You are Order and may place either X or O each turn. The bot is Chaos.",
      how: ["Tap a square, then pick X or O to place there.", "You want a line; the bot wants to fill the board without one."],
      win: "Make five of the same symbol in a row (all X or all O).",
      tip: "Use both symbols — an O can extend a run of your Os just as well as an X."
    },
    misere: {
      you: "You play the green ✕. The bot plays the blue ◯.",
      how: ["Tap an empty square to place your mark.", "This is tic-tac-toe in reverse."],
      win: "Force the bot to make three in a row — making three yourself LOSES.",
      tip: "Avoid taking two of your marks in the same line unless you have to."
    },
    uttt: {
      you: "You play the green ✕. The bot plays the blue ◯.",
      how: ["Each move is inside one of the nine small boards.", "The cell you pick sends the bot to the matching small board next.", "Win a small board to claim it on the big grid."],
      win: "Win three small boards in a row on the big grid.",
      tip: "Think about where your move sends the bot — don't gift it a board it can win."
    },
    hexapawn: {
      you: "You play the light pawns at the bottom (they move up).",
      how: ["Tap a pawn, then a highlighted square.", "Pawns step straight forward into an empty square, or capture one square diagonally forward."],
      win: "Reach the far row, capture all the bot's pawns, or leave it with no move.",
      tip: "Sometimes forcing an exchange is what leaves the bot stuck."
    },
    breakthrough: {
      you: "You play the light pawns (they move up the board).",
      how: ["Tap a pawn, then a highlighted square.", "Step straight forward into an empty square, or move/capture one square diagonally forward."],
      win: "Be the first to land a pawn on the far rank.",
      tip: "A defended column is hard to break — attack where you outnumber the bot."
    },
    domineering: {
      you: "You place vertical tiles (each covers a cell and the one below it).",
      how: ["Tap a highlighted cell to drop your vertical tile there.", "The bot places horizontal tiles. Tiles never overlap."],
      win: "Leave the bot with no room for a tile — whoever can't move loses.",
      tip: "Every tile you place removes two of the bot's horizontal options — play to cramp its space."
    },
    ponghau: {
      you: "You play the light pieces. The bot plays the red ones.",
      how: ["Tap a piece, then the connected empty spot to slide it there.", "Only the one open spot can be filled at a time."],
      win: "Trap the bot so it has no legal move.",
      tip: "Control the center junction — it connects to the most points."
    },
    achi: {
      you: "You play the light pieces. The bot plays the red ones.",
      how: ["First place your three pieces on the board, one per turn.", "Then slide a piece to a connected empty point."],
      win: "Line up your three pieces in a row.",
      tip: "The center point touches every line — hold it."
    },
    battleship: {
      you: "The top grid is enemy waters; your fleet sits below.",
      how: ["Tap a cell in the top grid to fire there.", "✳ is a hit, · is a miss. A hit lets you fire again."],
      win: "Sink the bot's whole hidden fleet before it sinks yours.",
      tip: "After a hit, fire the cells right next to it to finish the ship."
    },
    memory: {
      you: "You and the bot flip from the same face-down grid.",
      how: ["Tap two cards to flip them.", "A matching pair stays up and you go again; a mismatch flips back and passes the turn."],
      win: "Collect more matching pairs than the bot.",
      tip: "Remember where mismatched cards were — that's the whole game."
    },
    gofish: {
      you: "Your hand of ranks is shown as buttons.",
      how: ["Tap a rank to ask the bot for it.", "If it has that rank you take the cards and ask again; if not, you 'go fish' and draw."],
      win: "Collect the most books (four of a kind).",
      tip: "Only ask for ranks you already hold — that's how you complete books."
    },
    pig: {
      you: "You roll first each turn.",
      how: ["Roll to add the die to your running total for this turn.", "Hold to bank it — but if you roll a 1, you lose the whole turn's points."],
      win: "Be the first to reach 100 points.",
      tip: "Banking around 20 a turn is a solid rhythm; chase more only when you're behind."
    },
    dominoes: {
      you: "Your tiles are at the bottom; playable ones are highlighted.",
      how: ["Tap a highlighted tile to add it to an open end of the chain.", "Its number must match the end. Nothing fits? Draw, or pass if the stock is empty."],
      win: "Be the first to play your last tile (or hold the lightest hand if it locks).",
      tip: "Play your heaviest tiles early so you're not stuck holding them."
    },
    oware: {
      you: "You own the bottom row of pits.",
      how: ["Tap one of your pits to sow its seeds counter-clockwise.", "If your last seed lands in an opponent pit and makes it 2 or 3, you capture it and back along the row."],
      win: "Be the first to capture more than half the seeds (25 of 48).",
      tip: "Build up a big pit to reach deep into the bot's row for a multi-pit capture."
    },
    fifteen: {
      you: "You claim the green numbers. The bot claims the blue ones.",
      how: ["Tap an unclaimed number from 1 to 9 to take it.", "Each number can only be taken once."],
      win: "Be the first to hold three of your numbers that add up to exactly 15.",
      tip: "It's tic-tac-toe in disguise — 5 is the center, so grab it early."
    },
    kayles: {
      you: "Both players knock down the same row of pins.",
      how: ["Tap one pin to knock it down.", "Or tap two neighboring pins to knock down both at once."],
      win: "Knock down the last pin.",
      tip: "Splitting the row into two equal halves keeps the advantage on your side."
    },

    /* ---- coming soon (shown as a teaser) ---------------------------------- */
    chess: { soon: true, how: ["The full game of chess is on the way — ranked matches and staked tables."], win: "Checkmate the enemy king." },
    ludo: { soon: true, how: ["Roll and race your four tokens home, for 2 to 4 players. Coming soon."], win: "Get all four tokens home first." },
    backgammon: { soon: true, how: ["Roll the dice, race your checkers around the board and bear them off. Coming soon."], win: "Bear off all your checkers first." },
    spades: { soon: true, how: ["Bid the tricks you'll take and hit your target as a partnership. Coming soon."], win: "Reach the target score first." },
    hearts: { soon: true, how: ["Avoid taking hearts and the queen of spades — lowest score wins. Coming soon."], win: "Have the fewest points when the game ends." },
    poker: { soon: true, how: ["Heads-up Texas hold'em tables, staked in rcoin. Coming soon."], win: "Win your opponent's chips." }
  };
})();
