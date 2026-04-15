response = '{"ok":true,"connection_id":"c9fc4e21-f284-4c86-999f-ddedd5649734","cursor":0,"next_cursor":20,"commands":[{"id":"30139e33-3f82-44ef-a3ee-26c91796af18","sequence_no":20,"command_type":"arm_trade","payload":{"tp1":4808.61,"tp2":4856.22,"bias":"neutral","side":"buy","pivot":4761,"symbol":"XAUUSDm","auto_rr1":1.5,"auto_rr2":2.5,"setup_id":"672f38ba-4fb8-494c-b288-7f2c71906aad","timeframe":"5m","entry_price":4761,"use_auto_rr":true,"zone_percent":0.5,"ai_sensitivity":3,"trade_plan_notes":"Phase6 auto arm_trade test \u2014 fresh case run"},"idempotency_key":"arm_trade:c9fc4e21-f284-4c86-999f-ddedd5649734:672f38ba-4fb8-494c-b288-7f2c71906aad","created_at":"2026-04-14T05:49:11.256759+00:00","expires_at":"2026-04-15T05:49:10.63606+00:00","status":"pending"}]}'

print(f"Response length: {len(response)}")

def find_matching_json_token(json, start_pos, open_char, close_char):
    depth = 0
    for i in range(start_pos, len(json)):
        ch = json[i]
        if ch == open_char:
            depth += 1
        elif ch == close_char:
            depth -= 1
            if depth == 0:
                return i
    return -1

def json_extract_array_after(json, from_pos, key):
    marker = '"' + key + '"'
    key_pos = json.find(marker, from_pos)
    if key_pos < 0:
        print(f"  key '{key}' not found")
        return ""
    
    colon_pos = json.find(':', key_pos + len(marker))
    if colon_pos < 0:
        print(f"  no colon after key '{key}'")
        return ""
    
    start = colon_pos + 1
    while start < len(json) and json[start] in (' ', '\t', '\r', '\n'):
        start += 1
    
    if start >= len(json) or json[start] != '[':
        print(f"  expected '[' at pos {start}, got '{json[start] if start < len(json) else 'EOF'}'")
        return ""
    
    finish = find_matching_json_token(json, start, '[', ']')
    print(f"  key_pos={key_pos} colon_pos={colon_pos} start={start} finish={finish}")
    if finish < start:
        print(f"  ERROR: finish {finish} < start {start}")
        return ""
    
    return json[start:finish+1]

# Test JsonExtractArrayAfter
print("\nTesting JsonExtractArrayAfter:")
result = json_extract_array_after(response, 0, "commands")
if result:
    print(f"  SUCCESS: extracted {len(result)} chars")
    print(f"  First 100: {result[:100]}")
else:
    print("  FAILED: returned empty string")

# Check for any unexpected brackets
print(f"\nBracket analysis in response:")
open_brackets = [(i, c) for i, c in enumerate(response) if c == '[']
close_brackets = [(i, c) for i, c in enumerate(response) if c == ']']
print(f"  '[' positions: {[p for p,_ in open_brackets]}")
print(f"  ']' positions: {[p for p,_ in close_brackets]}")

# Check for non-ASCII characters
print(f"\nNon-ASCII characters:")
for i, c in enumerate(response):
    if ord(c) > 127:
        print(f"  pos={i} char='{c}' code={ord(c):#06x}")
