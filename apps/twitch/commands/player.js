const playerNotes = {
  "wade": "Legend - Best Scorer. Too many options/failsafes",
  "eodman": "Legend - Best rebounder. Insane sprint cooldown reset ability. Insane dive. Dirk counter. GOAT.",
  "westbrook": "Superstar - Fastest character? Great intercept ability. Wide dribbles that can be hard to guard solo.",
  "jjj": "Elite - Great blocker and can space the floor.",
  "j3": "Elite - Great blocker and can space the floor.",
  "sga": "Superstar - Some say he's a better scorer than Wade. I disagree.",
  "tatum": "Superstar - Solid all-rounder.",
  "olajuwon": "Legend - Best scoring center? 360 block in the paint.",
  "hakeem": "Legend - Best scoring center? 360 block in the paint.",
  "kidd": "Legend - Dunk passing is fun.",
  "murray": "Elite - Literally broken.",
  "george": "Elite - Weird dribbles. Solid.",
  "lopez": "Elite - His circle shit is really good. Nice E2 for double big.",
  "durant": "Superstar - Wide lanky dribbles. Solid block range.",
  "embiid": "Superstar - Can rebound, space, and score.",
  "leonard": "Superstar - Great help D.",
  "davis": "Superstar - Best bigman for countering spacing teams. E2 can give him a higher rebound stat than Rodman.",
  "gasol": "Superstar - Solid bigman. Idk too much about him.",
  "james": "Superstar - 360 block",
  "giannis": "Superstar - Best dunker. Best ult activation: 'Here comes the supermodel!'",
  "jokic": "Superstar - Pick n roll. Defensive liability.",
  "curry": "Superstar - Not a 1v1 scorer.. Stop it. Great dasher.",
  "paul": "Elite - Only player with garunteed steals? Dunking is fun.",
  "doncic": "Elite - Pick n roll.",
  "zion": "Elite - Dunking is fun.",
  "booker": "Elite - Solid scorer.",
  "mcCollum": "Elite - Idk much about him tbh.",
  "clarkson": "Elite - Idk much about him tbh.",
  "nowitzky": "Legend - Virtually unblockable, but easy to contest.",
  "wiggins": "Elite - Idk much about him tbh.",
  "deRozan": "Elite - Idk much about him tbh.",
  "lavine": "Elite - Dunking is fun.. sometimes.",
  "thompson": "Elite - Better dash scorers will be released to pair with curry.",
  "capela": "Elite - Rim protector. Slow af.",
  "anderson": "Elite - Idk much about him tbh.",
  "fuzhi": "Elite - Can stop dribblers.",
  "fu zhi": "Elite - Can stop dribblers.",
  "julio": "Elite - Idk much about him tbh. Low stats, he is an elite of course.",
  "ingram": "Elite - Idk much about him tbh.",
  "porzingis": "Elite - Not Lopez.",
  "adebayo": "Elite - Slaps rebounds.",
};


export default {
  name: 'player',
  desc: 'Show info or tier for a player. Usage: !player <name>',
  usage: '!player <name>',
  cooldownMs: 3000,

  async exec({ channel, args, client }) {
    console.log("!player args:", args);
    if (!args.length) {
      await client.say(channel, 'Usage: !player <name>');
      return;
    }

    const query = args.join(' ').toLowerCase();
    console.log("!player query:", query);

    const notes = playerNotes[query];

    if (!notes) {
      await client.say(channel, `No player by that name found.`);
      return;
    }

    await client.say(channel, notes);
  },
};
