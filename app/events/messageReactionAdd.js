import { onRollReaction } from '../../lib/characterRollRuntime.js';
/** @param {any} options */
export function createReactionHandler({ yoshiko, isReady }) {
    return (reaction, user) => {
        if (!isReady())
            return;
        return onRollReaction(yoshiko, reaction, user).catch(error => console.error('Roll reaction failed:', error));
    };
}
