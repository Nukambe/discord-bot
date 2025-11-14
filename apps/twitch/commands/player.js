const playerNotes = {
  "Wade": "Legend - Best Scorer. Too many options/failsafes",
  "Rodman": "Legend - Best rebounder. Insane sprint cooldown reset ability. Insane dive. Dirk counter. GOAT.",
  "Westbrook": "Superstar - Fastest character? Great intercept ability. Wide dribbles that can be hard to guard solo.",
  "JJJ": "Elite - Great blocker and can space the floor.",
  "J3": "Elite - Great blocker and can space the floor.",
  "SGA": "Superstar - Some say he's a better scorer than Wade. I disagree.",
  "Tatum": "Superstar - Solid all-rounder.",
  "Olajuwon": "Legend - Best scoring center? 360 block in the paint.",
  "Hakeem": "Legend - Best scoring center? 360 block in the paint.",
  "Kidd": "Legend - Dunk passing is fun.",
  "Murray": "Elite - Literally broken.",
  "George": "Elite - Weird dribbles. Solid.",
  "Lopez": "Elite - His circle shit is really good. Nice E2 for double big.",
  "Durant": "Superstar - Wide lanky dribbles. Solid block range.",
  "Embiid": "Superstar - Can rebound, space, and score.",
  "Leonard": "Superstar - Great help D.",
  "Davis": "Superstar - Best bigman for countering spacing teams. E2 can give him a higher rebound stat than Rodman.",
  "Gasol": "Superstar - Solid bigman. Idk too much about him.",
  "James": "Superstar - 360 block",
  "Giannis": "Superstar - Best dunker. Best ult activation: 'Here comes the supermodel!'",
  "Jokic": "Superstar - Pick n roll. Defensive liability.",
  "Curry": "Superstar - Not a 1v1 scorer.. Stop it. Great dasher.",
  "Paul": "Elite - Only player with garunteed steals? Dunking is fun.",
  "Doncic": "Elite - Pick n roll.",
  "Zion": "Elite - Dunking is fun.",
  "Booker": "Elite - Solid scorer.",
  "McCollum": "Elite - Idk much about him tbh.",
  "Clarkson": "Elite - Idk much about him tbh.",
  "Nowitzky": "Legend - Virtually unblockable, but easy to contest.",
  "Wiggins": "Elite - Idk much about him tbh.",
  "DeRozan": "Elite - Idk much about him tbh.",
  "Lavine": "Elite - Dunking is fun.. sometimes.",
  "Thompson": "Elite - Better dash scorers will be released to pair with curry.",
  "Capela": "Elite - Rim protector. Slow af.",
  "Anderson": "Elite - Idk much about him tbh.",
  "Fu Zhi": "Elite - Can stop dribblers.",
  "Julio": "Elite - Idk much about him tbh. Low stats, he is an elite of course.",
  "Ingram": "Elite - Idk much about him tbh.",
  "Porzingis": "Elite - Not Lopez.",
  "Adebayo": "Elite - Slaps rebounds.",
};


export default {
  name: 'player',
  desc: 'Show info or tier for a player. Usage: !player <name>',
  usage: '!player <name>',
  cooldownMs: 3000,

  async exec({ channel, args, client }) {
    if (!args.length) {
      await client.say(channel, 'Usage: !player <name>');
      return;
    }

    const query = args.join(' ').toLowerCase();

    const notes = playerNotes[query];

    if (!notes) {
      await client.say(channel, `No player by that name found.`);
      return;
    }

    await client.say(channel, notes);
  },
};
