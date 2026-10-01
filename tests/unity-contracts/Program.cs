// Deserializes captured API responses into the generated DTOs with strict settings:
// any JSON property without a DTO field fails (MissingMemberHandling.Error).
using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

var settings = new JsonSerializerSettings { MissingMemberHandling = MissingMemberHandling.Error };
var asm = typeof(Conime.Api.Dto.Message).Assembly;
int ok = 0, failed = 0;
foreach (var file in Directory.GetFiles("fixtures", "*.json").OrderBy(f => f))
{
    var schema = Path.GetFileName(file).Split('.')[0];
    var type = asm.GetType("Conime.Api.Dto." + schema);
    try
    {
        if (type == null) throw new Exception("no DTO class " + schema);
        var json = File.ReadAllText(file);
        var obj = JsonConvert.DeserializeObject(json, type, settings);
        var back = JToken.Parse(JsonConvert.SerializeObject(obj, new JsonSerializerSettings { NullValueHandling = NullValueHandling.Include }));
        var original = JToken.Parse(json);
        if (!JToken.DeepEquals(Normalize(original), Normalize(back))) throw new Exception("round trip changed the payload");
        Console.WriteLine($"ok   {Path.GetFileName(file)}");
        ok++;
    }
    catch (Exception e)
    {
        Console.WriteLine($"FAIL {Path.GetFileName(file)}: {e.Message}");
        failed++;
    }
}
Console.WriteLine($"{ok} passed, {failed} failed");
return failed == 0 ? 0 : 1;

// numbers like 7.5 vs 7.50 and absent-vs-null are not meaningful differences
static JToken Normalize(JToken t) => t switch
{
    JObject o => new JObject(o.Properties().Where(p => p.Value.Type != JTokenType.Null).OrderBy(p => p.Name).Select(p => new JProperty(p.Name, Normalize(p.Value)))),
    JArray a => new JArray(a.Select(Normalize)),
    JValue v when v.Type == JTokenType.Float || v.Type == JTokenType.Integer => new JValue(Convert.ToDecimal(v.Value)),
    _ => t,
};
