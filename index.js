'use strict';

process.chdir(__dirname);

var fs            = require('fs');
var assert        = require('assert');
var deepExtend    = require('deep-extend');
var yaml          = require('js-yaml');
var HomeAssistant = require('./lib/home-assistant');
var config        = require('./config.json');

var defaults = {
  "apiUrl": "http://localhost:8123/api",
  "apiPassword": null,
  "defaultHidden": true,
  "keyDateAdded": "date_added",
  "keyDateUpdated": "date_updated",
  "customizeFile": "~/.homeassistant/customize.yaml",
  "customizeFileOutput": null,
  "debug": false
};

var config = deepExtend({}, defaults, config);

if (!config.apiUrl) {
  throw new Error('Parameter `apiUrl` is missing in config.json');
}

if (!config.customizeFile) {
  throw new Error('Parameter `customizeFile` is missing in config.json');
}

if ('undefined' === typeof config.customizeFileBackup) {
  config.customizeFileBackup = config.customizeFile + '.backup';
}

if (!config.customizeFileOutput) {
  config.customizeFileOutput = config.customizeFile;
}

if (config.customizeFile) {
  config.customizeFile = config.customizeFile.replace(/^~/, process.env['HOME']);
}

if (config.customizeFileOutput) {
  config.customizeFileOutput = config.customizeFileOutput.replace(/^~/, process.env['HOME']);
}

if (config.customizeFileBackup) {
  config.customizeFileBackup = config.customizeFileBackup.replace(/^~/, process.env['HOME']);
}

var hass = new HomeAssistant(config.apiUrl, config.apiPassword);

function entityDomain(x) {
  return x.entity_id.split('.', 1)[0];
}

function isSupported(x) {
  return -1 !== ['light', 'switch', 'group', 'scene', 'media_player', 'input_boolean', 'script'].indexOf(entityDomain(x));
}

function isHidden(x) {
  var hidden = x.attributes.haaska_hidden;

  if ('undefined' === typeof hidden) {
    hidden = config.defaultHidden;
  } else if (!hidden || 'no' === hidden || 'false' === hidden || '0' === hidden) {
    hidden = false;
  } else {
    hidden = true;
  }

  return hidden;
}

function toTitleCase(str) {
  return str.replace(/\w\S*/g, function(txt) {
    return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
  });
}

function currentTime() {
  var date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

if (!config.debug && config.customizeFileBackup) {
  fs.writeFileSync(config.customizeFileBackup, fs.readFileSync(config.customizeFile));
}

var haaska    = {};
var customize = yaml.safeLoad(fs.readFileSync(config.customizeFile, 'utf8'));

hass.get('states', function(err, res, body) {
  if (err) {
    throw err;
  }

  for (var i = 0; i < body.length; i++ ) {
    var x = body[i];

    if (!isSupported(x)) {
      continue;
    }

    var hidden = isHidden(x);

    haaska[x.entity_id] = {
      haaska_hidden: hidden
    };
  }

  deepExtend(haaska, customize);

  if (config.keyDateAdded || config.keyDateUpdated) {
    for (var entityId in haaska) {
      var entityNew = haaska[entityId];
      var entityOld = customize[entityId];

      if (config.keyDateAdded && 'undefined' === typeof entityOld) {
        entityNew[config.keyDateAdded] = currentTime();
      }

      if (config.keyDateUpdated) {
        try {
          assert.deepEqual(entityOld, entityNew);
        } catch (ex) {
          entityNew[config.keyDateUpdated] = currentTime();
        }
      }
    }
  }

  var dump = yaml.safeDump(haaska, {
    sortKeys: true
  });

  dump = dump.replace(/icon: 'mdi:[^']+'/g, function(match) {
    return match.replace(/'/g, '');
  });

  var lines = dump.split('\n');

  var output = [];
  var domain = '';

  var entityRegex = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\:$/;
  var quoteRegex  = /^(\s*[A-Za-z0-9_]+:\s*)([^\s]+'.+)$/;

  output.push('################################################################');
  output.push('## Customize');
  output.push('################################################################');

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    line = line.replace(quoteRegex, function(match, key, value) {
      return key + '"' + value + '"';
    });

    var matches = entityRegex.exec(line);

    if (matches) {
      if (matches[1] != domain) {
        domain = matches[1];

        output.push('');
        output.push('################################################');
        output.push('## ' + toTitleCase(domain.replace(/_/g, ' ')));
        output.push('################################################');
      }

      output.push('');
    }

    output.push(line);
  }

  output.push('################################################################');
  output.push('# Last Generated: ' + new Date());
  output.push('################################################################');
  output.push('');

  output = output.join('\n');

  if (config.debug) {
    console.log(output);
  } else {
    fs.writeFileSync(config.customizeFileOutput, output, 'utf8');
    console.log('%s has been updated', config.customizeFileOutput);
  }
});
