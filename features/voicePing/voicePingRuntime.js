import { readFileSync, writeFileSync } from "fs";
export async function startVoicePing(yoshiko) {
    const channel = await yoshiko.client.channels.fetch(yoshiko.config.channelId);
    const vc = yoshiko.client.channels.cache.get("1058299700006109280");
    //const pingChannel = "1284763165116076094"
    let userId = readFileSync("./data/user_id.txt", "utf-8").trim();
    let randomTimes = 0;
    //Read map from file
    let memberCounterMap = new Map(JSON.parse(readFileSync("./data/counter.txt", "utf-8")));
    const randomInterval = 100;
    setInterval(() => {
        //Check for run operation code
        const setRun = readFileSync('./data/set_run.txt', 'utf-8');
        // Check for minimum number of members in VC
        const minimumMembers = parseInt(readFileSync('./data/set_minimum_members.txt', 'utf-8'));
        if (setRun === "1") {
            //Get list of members in voice channel, excluding the bot
            let vcMembersId = vc.members.map(member => member.id === "610040267755749404" ? null : member.id);
            //Delete null in array
            vcMembersId.forEach((member) => {
                if (member === null) {
                    vcMembersId.splice(vcMembersId.indexOf(member), 1);
                }
            });
            //Check if VC is empty
            if (vcMembersId.length < minimumMembers) { // Bot is the only one in VC
                writeFileSync('./data/set_run.txt', "0");
                channel.send(`⏹️ Stopped due to VC has less than **${minimumMembers}** members.`);
            }
            let numOfMembers = vcMembersId.length;
            //Random algorithm
            const random = Math.floor(Math.random() * (1000 + 1));
            randomTimes++;
            /*if (setRun === 0) {
                counter = 0
            } else {
                counter = parseInt(readFileSync("./data/counter.txt", "utf-8"));
            }*/
            //Finding 727
            if (random === 727) {
                //Get random member in vc, excluding the bot
                let randomMember = vcMembersId[Math.floor(Math.random() * numOfMembers)];
                //Get random person in vc
                if (memberCounterMap.has(randomMember)) {
                    memberCounterMap.set(randomMember, memberCounterMap.get(randomMember) + 1);
                }
                else {
                    memberCounterMap.set(randomMember, 1);
                }
                userId = randomMember;
                const embed = {
                    color: 0xffff7d,
                    description: `<@${userId}> da bi ping ${memberCounterMap.get(randomMember)} lan\n727 da duoc tim thay sau ${randomTimes} lan (${(randomTimes / 10).toFixed(2)} giay)`,
                };
                channel.send({ content: `<@${userId}>`, embeds: [embed] });
                // Write current member counter map to counter.txt
                writeFileSync("./data/counter.txt", JSON.stringify(Array.from(memberCounterMap.entries())));
                randomTimes = 0;
            }
        }
    }, randomInterval);
}
