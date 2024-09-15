import {writeFileSync} from "fs";

export const run = async (ctx) => {
    writeFileSync('./data/set_run.txt', "0")
    if (ctx.message.author.id != "203699280261808138" && ctx.message.author.id != "227447542911074304") {
        ctx.message.channel.send("Bạn không có quyền sử dụng lệnh này!")
        return
    }
    const setId = takeId(ctx.args[1])
    console.log(setId)
    writeFileSync('./data/user_id.txt', setId.toString())
    writeFileSync('./data/counter.txt', "0")

}

function takeId(inp) {
    let string = inp.toString()
    return (string.replace('<', '').replace('@', '').replace('>', ''))
}