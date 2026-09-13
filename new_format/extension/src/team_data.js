/*
 * team_data.js
 *
 * Pulls JSON team data from Google database 
 */

var GOOGLE_API = 'https://script.google.com/macros/s/AKfycbwuBcTsLqVUq25MQxdBRshBa3k-AHX005jqBteP13t2entEvQcTn-nF294UQpVGPvdyHg/exec'

function getJsonFromId(id) {

    // Build the API URL
    var url = GOOGLE_API + '?function=id&name=' + encodeURIComponent(id);

    // Make GET request
    var response = UrlFetchAp.fetch(url);

    // Parse JSON response
    var json = JSON.parse(response.getContentText());

    // Check that the API succeeded
    if (!json.success || !json.data) {
        throw new Error('Google API returned an unsuccessful response.');
    }

    // Get the JSON data
    var data = json.data;

    // Get the team flag and Reddit logo code
    var flag = data['Flag'] || '';
    var logoCode = data['LOGO CODE'] || ''; 

    // Convert the flag to Reddit css formatting
    var flagCode = flagToCode(flag).toLowerCase();
    var langFlag = flag
        ? '[' + flag + '](#lang-' + flagCode + ')'
        : '';

    // Flag updates to use Reddit css flag formatting
    data['Flag'] = langFlag;

    // Flag Name updates to use the Reddit css logo formatting
    if (logoCode) {
        data['Flag Name'] = '[' + flag + '](#' + logoCode + '-logo) ' + data['Name'];
    } else {
        data['Flag Name'] = langFlag + ' ' + data['Name'];
    }

    // player/coaches fields
    var fields = [
        'PLAYER 1',
        'PLAYER 2',
        'PLAYER 3',
        'PLAYER 4',
        'PLAYER 5',
        'PLAYER 6',
        'COACH',
        'SUB 1',
        'SUB 2',
        'SUB 3',
        'SUB 4',
        'SUB 5',
        'SUB 6'
    ];

    // Change player/coaches to use Reddit css flag formatting
    fields.forEach(function(field) {
        if (data[field]) {
            data[field] = replacePlayerFlag(data[field]);
        }
    });

    return json;
}

function flagToCode(flag) {

    // Get the emoji characters
    var chars = [...flag];

    // Emoji flag should use 2 characters
    if (chars.length !== 2) {
        return '';
    }

    // Convert to two letter code
    return String.fromCharCode(
        chars[0].codePointAt(0) - 0x1F1E6 + 65,
        chars[1].codePointAt(0) - 0x1F1E6 + 65
    );
}

function replacePlayerFlag(player) {
    // Find the emoji flag at beginning of string
    var match = player.match(/^(\p{Regional_Indicator}{2})\s*(.*)$/u);

    // Return if there's not already a flag emoji
    if (!match) {
        return player;
    }

    // Separate flag and name parts
    var flag = match[1];
    var name = match[2];

    // Return updated player name with Reddit css formatting
    var code = flagToCode(flag).toLowerCase();
    return '[' + flag + '](#lang-' + code + ') ' + name;
}